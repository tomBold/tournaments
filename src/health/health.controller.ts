import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

type Status = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'error';
  postgres: Status;
  redis: Status;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Readiness: Postgres and Redis are reachable' })
  @ApiOkResponse({ schema: { example: { status: 'ok', postgres: 'up', redis: 'up' } } })
  @ApiServiceUnavailableResponse({ description: 'Postgres or Redis is unreachable' })
  async check(): Promise<HealthReport> {
    const [postgres, redis] = await Promise.all([
      probe(() => this.prisma.$queryRaw`SELECT 1`),
      probe(() => this.redis.ping()),
    ]);
    const report: HealthReport = {
      status: postgres === 'up' && redis === 'up' ? 'ok' : 'error',
      postgres,
      redis,
    };
    if (report.status !== 'ok') throw new ServiceUnavailableException(report);
    return report;
  }
}

async function probe(check: () => Promise<unknown>): Promise<Status> {
  try {
    await check();
    return 'up';
  } catch {
    return 'down';
  }
}
