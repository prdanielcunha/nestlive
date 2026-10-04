import { readFile } from 'node:fs/promises';

const manifestUrl = new URL(
  '../docs/certification/production-certification.json',
  import.meta.url
);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));

const REQUIRED = [
  'windowsIpad',
  'windowsAndroid',
  'x32MonteCastelo',
  'x32DualNetwork',
  'x32HourMeters',
  'soundcraftIndustrial',
  'holyricsResolumeTwoPc',
  'propresenterOnly',
  'internetCutLanContinuity',
  'nodeRestartNoReplay',
  'providerFailureIsolation',
  'commandObservedP95',
  'threeSimulatedServices',
  'accompaniedRealService',
  'volunteerUx',
  'realDeviceAccessibility',
  'windowsSignedInstallerTrust',
  'macosSignedNotarizedTrust',
  'branchProtection'
];

const errors = [];

if (manifest?.schemaVersion !== 1) {
  errors.push('schemaVersion must be 1');
}
if (
  typeof manifest?.candidateVersion !== 'string' ||
  !/^0\.1\.0(?:-beta\.\d+)?$/.test(manifest.candidateVersion)
) {
  errors.push('candidateVersion must be a NestLive 0.1.0 candidate');
}
if (manifest?.status !== 'approved') {
  errors.push('status must be approved');
}
if (
  typeof manifest?.approvedBy !== 'string' ||
  !manifest.approvedBy.trim()
) {
  errors.push('approvedBy is required');
}
if (
  typeof manifest?.approvedAt !== 'string' ||
  Number.isNaN(Date.parse(manifest.approvedAt))
) {
  errors.push('approvedAt must be an ISO date/time');
}

for (const key of REQUIRED) {
  const item = manifest?.evidence?.[key];
  if (
    !item ||
    item.result !== 'PASS' ||
    typeof item.ref !== 'string' ||
    !item.ref.trim()
  ) {
    errors.push(
      `evidence.${key} must contain PASS plus a non-empty evidence ref`
    );
  }
}

const latency = manifest?.evidence?.commandObservedP95;
if (
  latency?.result === 'PASS' &&
  (!Number.isFinite(latency.p95Ms) ||
    latency.p95Ms < 0 ||
    latency.p95Ms >= 300)
) {
  errors.push('commandObservedP95.p95Ms must be >= 0 and < 300');
}

const simulated = manifest?.evidence?.threeSimulatedServices;
if (
  simulated?.result === 'PASS' &&
  (!Number.isInteger(simulated.count) || simulated.count < 3)
) {
  errors.push('threeSimulatedServices.count must be >= 3');
}

const real = manifest?.evidence?.accompaniedRealService;
if (
  real?.result === 'PASS' &&
  (!Number.isInteger(real.count) || real.count < 1)
) {
  errors.push('accompaniedRealService.count must be >= 1');
}

if (errors.length) {
  console.error('NestLive production certification gate is CLOSED:');
  for (const error of errors) console.error(`- ${error}`);
  console.error(
    'Physical, signing and operational evidence is mandatory. ' +
      'Software completion alone cannot open this gate.'
  );
  process.exit(1);
}

console.log(
  `NestLive production certification gate: ${manifest.candidateVersion} APPROVED`
);
