#!/usr/bin/env bash
set -euo pipefail

: "${OCI_TENANCY_OCID:?OCI_TENANCY_OCID is required}"
: "${OCI_USER_OCID:?OCI_USER_OCID is required}"
: "${OCI_FINGERPRINT:?OCI_FINGERPRINT is required}"
: "${OCI_API_PRIVATE_KEY:?OCI_API_PRIVATE_KEY is required}"
: "${OCI_REGION:?OCI_REGION is required}"

mkdir -p "$HOME/.oci"
printf '%s\n' "$OCI_API_PRIVATE_KEY" > "$HOME/.oci/api_key.pem"
chmod 600 "$HOME/.oci/api_key.pem"
cat > "$HOME/.oci/config" <<CFG
[DEFAULT]
user=${OCI_USER_OCID}
fingerprint=${OCI_FINGERPRINT}
tenancy=${OCI_TENANCY_OCID}
region=${OCI_REGION}
key_file=${HOME}/.oci/api_key.pem
CFG
chmod 600 "$HOME/.oci/config"
oci iam region-subscription list --tenancy-id "$OCI_TENANCY_OCID" >/dev/null
