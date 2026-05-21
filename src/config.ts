import path from 'path';

export interface Config {
  baseImage: string;
  workImage: string;
  spareImage: string;
  sshPort: number;
  sshSparePort: number;
  sshUser: string;
  sshPassword: string;
  httpPort: number;
  httpsPort: number;
  sslCert: string;
  sslKey: string;
  generateSelfSignedCert: boolean;
  qemuBin: string;
  qemuMemory: string;
  qemuCpus: string;
  restartDelayMs: number;
  sshRetryMs: number;
  sshTimeoutMs: number;
  watchdogIntervalMs: number;
  watchdogMaxFailures: number;
  outputBufferBytes: number;
  publicDir: string;
}

export const config: Config = Object.freeze({
  baseImage: process.env['BASE_IMAGE'] ?? 'vm/base.img',
  workImage: process.env['WORK_IMAGE'] ?? 'vm/work.img',
  spareImage: process.env['SPARE_IMAGE'] ?? 'vm/spare.img',
  sshPort: parseInt(process.env['SSH_PORT'] ?? '2222', 10),
  sshSparePort: parseInt(process.env['SSH_SPARE_PORT'] ?? '2223', 10),
  sshUser: process.env['SSH_USER'] ?? 'root',
  sshPassword: process.env['SSH_PASSWORD'] ?? '',
  httpPort: parseInt(process.env['HTTP_PORT'] ?? process.env['PORT'] ?? '80', 10),
  httpsPort: parseInt(process.env['HTTPS_PORT'] ?? '443', 10),
  sslCert: process.env['SSL_CERT'] ?? '',
  sslKey: process.env['SSL_KEY'] ?? '',
  generateSelfSignedCert: (process.env['GENERATE_SELF_SIGNED_CERT'] ?? 'false') === 'true',
  qemuBin: process.env['QEMU_BIN'] ?? 'qemu-system-x86_64',
  qemuMemory: process.env['QEMU_MEM'] ?? '512M',
  qemuCpus: process.env['QEMU_CPUS'] ?? '1',
  restartDelayMs: 5000,
  sshRetryMs: 5000,
  sshTimeoutMs: 15 * 60 * 1000,
  watchdogIntervalMs: 15000,
  watchdogMaxFailures: 3,
  outputBufferBytes: 32 * 1024,
  publicDir: path.join(__dirname, '..', 'public'),
});
