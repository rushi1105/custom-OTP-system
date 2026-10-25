#!/usr/bin/env node
/**
 * Isolated-test deployment preflight (no deployment, no network, no secrets
 * printed). Run after `npm run build` with the target test project's
 * non-secret environment configured.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const passes = [];

function pass(message) {
  passes.push(message);
}
function warn(message) {
  warnings.push(message);
}
function fail(message) {
  errors.push(message);
}
function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
}

const environment = (process.env['OTP_ENVIRONMENT'] ?? '').trim();
const provider = (process.env['DELIVERY_PROVIDER'] ?? '').trim();
const pepperVersion = (process.env['OTP_HASH_PEPPER_VERSION'] ?? '').trim();
const projectId = (
  process.env['FIREBASE_PROJECT_ID'] ??
  process.env['GCLOUD_PROJECT'] ??
  ''
).trim();

if (environment !== 'test') {
  fail(
    'OTP_ENVIRONMENT must be "test" for this milestone (isolated test only; local/staging/production are not authorized).',
  );
} else {
  pass('OTP_ENVIRONMENT=test');
}

if (!/^[1-9]\d{0,8}$/.test(pepperVersion)) {
  fail('OTP_HASH_PEPPER_VERSION must be a positive integer with no leading zeros.');
} else {
  pass(`OTP_HASH_PEPPER_VERSION=${pepperVersion}`);
}

if (provider === '') {
  fail('DELIVERY_PROVIDER must be set explicitly outside local.');
} else if (provider === 'mock') {
  warn(
    'DELIVERY_PROVIDER=mock: no real SMS will be delivered. A full deployed OTP smoke needs a real adapter or an operator-run test challenge seed.',
  );
} else {
  fail(
    `DELIVERY_PROVIDER="${provider}" is not implemented; only the mock provider exists. Do not deploy a provider that cannot deliver.`,
  );
}

if (projectId === '') {
  fail('FIREBASE_PROJECT_ID (or GCLOUD_PROJECT) must identify the isolated test project.');
} else if (projectId.startsWith('demo-')) {
  fail(`"${projectId}" is an emulator demo project and cannot be deployed.`);
} else if (projectId === 'coolbus-1db23') {
  fail('Refusing the CoolBus production project; use a dedicated isolated OTP test project.');
} else {
  pass(`target project id set (${projectId})`);
}

if ((process.env['FUNCTIONS_EMULATOR'] ?? '').toLowerCase() === 'true') {
  fail(
    'FUNCTIONS_EMULATOR=true is present; this preflight is for a deployed isolated test project.',
  );
}

if (!existsSync(resolve(root, 'functions', 'dist', 'index.js'))) {
  fail('functions/dist/index.js is missing; run `npm run build` first.');
} else {
  const dist = readFileSync(resolve(root, 'functions', 'dist', 'index.js'), 'utf8');
  const functionsPackage = readJson('functions/package.json');
  const dependencyNames = new Set(Object.keys(functionsPackage.dependencies ?? {}));

  if (dist.includes('@otp-infra/contracts')) {
    fail('Compiled functions output contains a runtime @otp-infra/contracts import.');
  } else {
    pass('compiled output has no runtime @otp-infra/contracts import');
  }

  for (const exportName of ['health', 'requestOtp', 'verifyOtp']) {
    if (!dist.includes(`exports.${exportName}`)) {
      fail(`compiled output is missing the ${exportName} export.`);
    }
  }

  const bareRequires = [...dist.matchAll(/require\(["']([^"']+)["']\)/g)]
    .map((match) => match[1])
    .filter(
      (specifier) =>
        !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:'),
    )
    .map((specifier) =>
      specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0],
    );

  for (const dependency of new Set(bareRequires)) {
    if (!dependencyNames.has(dependency)) {
      fail(`compiled output requires "${dependency}" but it is not a functions dependency.`);
    }
  }
  if (errors.length === 0) {
    pass('compiled bare-module requires are declared dependencies');
  }

  if (functionsPackage.main !== 'dist/index.js') {
    fail('functions/package.json main must be dist/index.js.');
  } else {
    pass('functions main entry point is dist/index.js');
  }
  if (functionsPackage.engines?.node !== '22') {
    warn('functions/package.json engines.node should remain 22 for the deployed runtime.');
  } else {
    pass('functions runtime target is Node 22');
  }
}

const firebaseJson = readJson('firebase.json');
if (firebaseJson.functions?.source !== 'functions') {
  fail('firebase.json functions.source must be "functions".');
} else {
  pass('firebase.json functions source is configured');
}
const predeploy = firebaseJson.functions?.predeploy;
const hasBuild =
  Array.isArray(predeploy) &&
  predeploy.some((command) => typeof command === 'string' && command.includes('run build'));
if (!hasBuild) {
  fail('firebase.json functions.predeploy must run the functions build.');
} else {
  pass('firebase.json predeploy builds functions');
}

if (
  firebaseJson.firestore?.rules !== 'firestore.rules' ||
  !existsSync(resolve(root, 'firestore.rules'))
) {
  fail('firebase.json firestore.rules must reference the committed firestore.rules file.');
} else {
  pass('firestore rules are configured for deployment');
}

const indexSource = readFileSync(resolve(root, 'functions', 'src', 'index.ts'), 'utf8');
if (!/defineSecret\(\s*['"]OTP_HASH_PEPPER['"]\s*\)/.test(indexSource)) {
  fail('functions/src/index.ts does not bind the OTP_HASH_PEPPER Secret Manager parameter.');
} else {
  pass('OTP_HASH_PEPPER is declared via defineSecret');
}
if (
  !/secrets:\s*\[\s*otpHashPepperSecret\s*\]/.test(indexSource) ||
  !indexSource.includes('otpHashPepperSecret.value()')
) {
  fail('OTP_HASH_PEPPER secret is not bound to both callables and read at runtime.');
} else {
  pass('OTP_HASH_PEPPER is bound to callables and read at runtime');
}

let trackedFiles = [];
try {
  trackedFiles = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
} catch {
  warn('could not inspect tracked files with git; verify no secrets are committed manually.');
}
const suspiciousTracked = trackedFiles.filter((file) => {
  const name = basename(file);
  if (name === '.env.example') return false;
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    name === '.secret.local' ||
    name.endsWith('.secret.local') ||
    /serviceaccount.*\.json$/i.test(name) ||
    /service-account.*\.json$/i.test(name)
  );
});
if (suspiciousTracked.length > 0) {
  fail(`sensitive-looking files are tracked: ${suspiciousTracked.join(', ')}`);
} else {
  pass('no tracked .env or service-account files (excluding .env.example)');
}

warn(
  'D-009 remains open: workspace/file-dependency packaging is not validated by firebase deploy. Runtime contracts import check passed, but the packaging strategy (recommended: esbuild bundle) needs owner approval.',
);
warn(
  'D-018 remains open: App Check is not enforced. Unauthenticated callables are isolated-test only until an owner policy is approved.',
);
warn(
  'D-020 owner action: provision OTP_HASH_PEPPER in the target project; the preflight does not contact Secret Manager or print any secret.',
);

console.log('OTP isolated-test deployment preflight');
for (const message of passes) console.log(`PASS  ${message}`);
for (const message of warnings) console.log(`WARN  ${message}`);
for (const message of errors) console.log(`FAIL  ${message}`);

if (errors.length > 0) {
  console.error(`\nPreflight failed with ${errors.length} error(s); no deployment was performed.`);
  process.exitCode = 1;
} else {
  console.log(
    '\nConfiguration preflight passed. Deployment is still blocked by the open owner decisions and the mock-provider delivery gap; no deployment was performed.',
  );
}
