import fs from 'node:fs';
import path from 'node:path';

const [requestedProvider = 'auto', requestedRuntime = 'auto', sourceRoot = '.', workingDirectory = '.'] = process.argv.slice(2);
const workdir = path.resolve(sourceRoot, workingDirectory);

function exists(name) {
  return fs.existsSync(path.join(workdir, name));
}

let runtime = requestedRuntime;
if (runtime === 'auto') {
  if (exists('wrangler.jsonc') || exists('wrangler.json') || exists('wrangler.toml')) {
    runtime = 'worker';
  } else if (exists('package.json') || exists('Dockerfile')) {
    runtime = 'node';
  } else {
    throw new Error(`Could not auto-detect runtime in ${workdir}. Expected Wrangler config, package.json, or Dockerfile.`);
  }
}

if (!['worker', 'node'].includes(runtime)) {
  throw new Error(`Unsupported runtime: ${runtime}`);
}

let provider = requestedProvider;
if (provider === 'auto') {
  provider = runtime === 'worker' ? 'cloudflare' : 'oracle';
}

if (!['cloudflare', 'oracle'].includes(provider)) {
  throw new Error(`Unsupported provider: ${provider}`);
}
if (provider === 'cloudflare' && runtime !== 'worker') {
  throw new Error('Cloudflare provider currently requires runtime=worker. Use Oracle for a persistent Node/Gateway process.');
}

process.stdout.write(`provider=${provider}\nruntime=${runtime}\n`);
