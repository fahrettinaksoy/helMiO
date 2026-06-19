// Headless end-to-end test of the diagnose + install flow against a container.
// Usage: node test/run.mjs [container-name]   (default: helmio-test-debian)
import { installerService } from '../backend/src/services/installerService.js';

const container = process.argv[2] || 'helmio-test-debian';
const server = {
  id: `test-${container}`,
  method: 'docker',
  container,
  connection: 'socket',
  dockerSocket: '/var/run/docker.sock',
  updatedAt: 'test',
};

console.log(`\n=== detect (${container}) ===`);
console.log(await installerService.detect(server));

console.log('\n=== install (canlı log) ===');
const result = await installerService.install(server, { configureHttp: true }, (line) => {
  process.stdout.write(line.endsWith('\n') ? line : line + '\n');
});
console.log('\n=== result ===');
console.log(result);

console.log('\n=== re-detect ===');
console.log(await installerService.detect(server));
