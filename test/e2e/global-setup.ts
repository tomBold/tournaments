import { execSync } from 'node:child_process';

export default function globalSetup(): void {
  require('./env');
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: process.env });
}
