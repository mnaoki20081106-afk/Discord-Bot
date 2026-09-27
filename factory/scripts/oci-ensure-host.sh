#!/usr/bin/env bash
set -euo pipefail

: "${OCI_COMPARTMENT_OCID:?OCI_COMPARTMENT_OCID is required}"
: "${BOT_FACTORY_SSH_PRIVATE_KEY:?BOT_FACTORY_SSH_PRIVATE_KEY is required}"

PREFIX="${BOT_FACTORY_OCI_PREFIX:-discord-bot-factory}"
VCN_NAME="${PREFIX}-vcn"
SUBNET_NAME="${PREFIX}-subnet"
IGW_NAME="${PREFIX}-igw"
INSTANCE_NAME="${PREFIX}-host"
VCN_CIDR="10.42.0.0/16"
SUBNET_CIDR="10.42.0.0/24"

json_id_by_name() {
  local json="$1" name="$2"
  jq -r --arg n "$name" '.data[]? | select(."display-name"==$n and (."lifecycle-state" // "AVAILABLE") != "TERMINATED") | .id' <<<"$json" | head -n1
}

vcn_json="$(oci network vcn list --compartment-id "$OCI_COMPARTMENT_OCID" --all)"
VCN_ID="$(json_id_by_name "$vcn_json" "$VCN_NAME")"
if [[ -z "$VCN_ID" ]]; then
  VCN_ID="$(oci network vcn create     --compartment-id "$OCI_COMPARTMENT_OCID"     --display-name "$VCN_NAME"     --cidr-block "$VCN_CIDR"     --dns-label botfactory     --wait-for-state AVAILABLE     --query 'data.id' --raw-output)"
fi

echo "VCN: $VCN_ID"
VCN_INFO="$(oci network vcn get --vcn-id "$VCN_ID")"
ROUTE_TABLE_ID="$(jq -r '.data."default-route-table-id"' <<<"$VCN_INFO")"
SECURITY_LIST_ID="$(jq -r '.data."default-security-list-id"' <<<"$VCN_INFO")"

igw_json="$(oci network internet-gateway list --compartment-id "$OCI_COMPARTMENT_OCID" --vcn-id "$VCN_ID" --all)"
IGW_ID="$(json_id_by_name "$igw_json" "$IGW_NAME")"
if [[ -z "$IGW_ID" ]]; then
  IGW_ID="$(oci network internet-gateway create     --compartment-id "$OCI_COMPARTMENT_OCID"     --vcn-id "$VCN_ID"     --display-name "$IGW_NAME"     --is-enabled true     --wait-for-state AVAILABLE     --query 'data.id' --raw-output)"
fi

ROUTE_RULES="$(jq -nc --arg igw "$IGW_ID" '[{"cidrBlock":"0.0.0.0/0","networkEntityId":$igw}]')"
oci network route-table update --rt-id "$ROUTE_TABLE_ID" --route-rules "$ROUTE_RULES" --force >/dev/null

INGRESS_RULES='[{"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":22,"max":22}}}]'
EGRESS_RULES='[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]'
oci network security-list update   --security-list-id "$SECURITY_LIST_ID"   --ingress-security-rules "$INGRESS_RULES"   --egress-security-rules "$EGRESS_RULES"   --force >/dev/null

subnet_json="$(oci network subnet list --compartment-id "$OCI_COMPARTMENT_OCID" --vcn-id "$VCN_ID" --all)"
SUBNET_ID="$(json_id_by_name "$subnet_json" "$SUBNET_NAME")"
if [[ -z "$SUBNET_ID" ]]; then
  SUBNET_ID="$(oci network subnet create     --compartment-id "$OCI_COMPARTMENT_OCID"     --vcn-id "$VCN_ID"     --display-name "$SUBNET_NAME"     --cidr-block "$SUBNET_CIDR"     --dns-label bots     --route-table-id "$ROUTE_TABLE_ID"     --security-list-ids "[\"$SECURITY_LIST_ID\"]"     --prohibit-public-ip-on-vnic false     --wait-for-state AVAILABLE     --query 'data.id' --raw-output)"
fi

instances="$(oci compute instance list --compartment-id "$OCI_COMPARTMENT_OCID" --display-name "$INSTANCE_NAME" --all)"
INSTANCE_ID="$(jq -r --arg n "$INSTANCE_NAME" '.data[]? | select(."display-name"==$n and ."lifecycle-state" != "TERMINATED") | .id' <<<"$instances" | head -n1)"

SSH_KEY_FILE="$(mktemp)"
trap 'rm -f "$SSH_KEY_FILE"' EXIT
printf '%s\n' "$BOT_FACTORY_SSH_PRIVATE_KEY" > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
SSH_PUBLIC_KEY="$(ssh-keygen -y -f "$SSH_KEY_FILE")"

if [[ -z "$INSTANCE_ID" ]]; then
  cloud_init="$(mktemp)"
  cat > "$cloud_init" <<'CLOUD'
#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io ca-certificates curl jq
systemctl enable --now docker
usermod -aG docker ubuntu || true
mkdir -p /opt/bot-factory/apps
chown -R ubuntu:ubuntu /opt/bot-factory
CLOUD
  USER_DATA="$(base64 -w 0 "$cloud_init")"
  rm -f "$cloud_init"
  METADATA="$(jq -nc --arg ssh "$SSH_PUBLIC_KEY" --arg user_data "$USER_DATA" '{ssh_authorized_keys:$ssh,user_data:$user_data}')"

  mapfile -t ADS < <(oci iam availability-domain list --compartment-id "$OCI_TENANCY_OCID" | jq -r '.data[].name')
  if [[ "${#ADS[@]}" -eq 0 ]]; then
    echo "::error::No OCI availability domains were returned."
    exit 1
  fi

  launch_ok=0
  for shape in VM.Standard.E2.1.Micro VM.Standard.A1.Flex; do
    IMAGE_ID="$(oci compute image list       --compartment-id "$OCI_COMPARTMENT_OCID"       --operating-system 'Canonical Ubuntu'       --shape "$shape"       --all | jq -r '.data | sort_by(."time-created") | reverse | .[0].id // empty')"
    [[ -n "$IMAGE_ID" ]] || continue

    for ad in "${ADS[@]}"; do
      echo "Trying OCI Always Free host: shape=$shape ad=$ad"
      set +e
      if [[ "$shape" == "VM.Standard.A1.Flex" ]]; then
        launch_json="$(oci compute instance launch           --availability-domain "$ad"           --compartment-id "$OCI_COMPARTMENT_OCID"           --display-name "$INSTANCE_NAME"           --shape "$shape"           --shape-config '{"ocpus":1,"memoryInGBs":6}'           --subnet-id "$SUBNET_ID"           --image-id "$IMAGE_ID"           --assign-public-ip true           --metadata "$METADATA"           --wait-for-state RUNNING 2>&1)"
      else
        launch_json="$(oci compute instance launch           --availability-domain "$ad"           --compartment-id "$OCI_COMPARTMENT_OCID"           --display-name "$INSTANCE_NAME"           --shape "$shape"           --subnet-id "$SUBNET_ID"           --image-id "$IMAGE_ID"           --assign-public-ip true           --metadata "$METADATA"           --wait-for-state RUNNING 2>&1)"
      fi
      status=$?
      set -e
      if [[ "$status" -eq 0 ]]; then
        INSTANCE_ID="$(jq -r '.data.id' <<<"$launch_json")"
        launch_ok=1
        break 2
      fi
      echo "$launch_json" >&2
    done
  done

  if [[ "$launch_ok" -ne 1 || -z "$INSTANCE_ID" ]]; then
    echo "::error::Could not provision an OCI Always Free compute host. Capacity may be unavailable in the home region."
    exit 1
  fi
else
  state="$(oci compute instance get --instance-id "$INSTANCE_ID" --query 'data."lifecycle-state"' --raw-output)"
  if [[ "$state" == "STOPPED" ]]; then
    oci compute instance action --instance-id "$INSTANCE_ID" --action START --wait-for-state RUNNING >/dev/null
  fi
fi

PUBLIC_IP=""
for attempt in $(seq 1 30); do
  PUBLIC_IP="$(oci compute instance list-vnics --instance-id "$INSTANCE_ID" | jq -r '.data[0]."public-ip" // empty')"
  [[ -n "$PUBLIC_IP" ]] && break
  sleep 5
done
if [[ -z "$PUBLIC_IP" ]]; then
  echo "::error::OCI host has no public IP."
  exit 1
fi

echo "OCI host: $INSTANCE_ID ($PUBLIC_IP)"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "instance_id=$INSTANCE_ID" >> "$GITHUB_OUTPUT"
  echo "public_ip=$PUBLIC_IP" >> "$GITHUB_OUTPUT"
fi
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "OCI_FACTORY_INSTANCE_ID=$INSTANCE_ID" >> "$GITHUB_ENV"
  echo "OCI_FACTORY_PUBLIC_IP=$PUBLIC_IP" >> "$GITHUB_ENV"
fi
