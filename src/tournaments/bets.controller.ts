import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { BetsService, IngestBetResult } from './bets.service';
import { CreateBetDto } from './dto/create-bet.dto';

@ApiTags('bets')
@Controller('bet')
export class BetsController {
  constructor(private readonly bets: BetsService) {}

  /** Always 200 for valid payloads (new or duplicate) so clients can retry safely. */
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ingest a bet (idempotent per externalBetId)' })
  @ApiOkResponse({
    description: 'Stored. Re-sending the same bet returns duplicate: true without changing scores.',
    schema: {
      example: {
        betId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        externalBetId: 'bet_123456',
        duplicate: false,
        countedTournamentIds: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid payload' })
  @ApiConflictResponse({ description: 'externalBetId already received with a different payload' })
  ingest(@Body() dto: CreateBetDto): Promise<IngestBetResult> {
    return this.bets.ingest(dto);
  }
}
