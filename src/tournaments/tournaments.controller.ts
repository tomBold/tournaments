import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CreateTournamentDto } from './dto/create-tournament.dto';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto';
import { TournamentsService } from './tournaments.service';

@ApiTags('tournaments')
@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly tournaments: TournamentsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a tournament and schedule its finalization' })
  @ApiCreatedResponse({
    description: 'The created tournament',
    schema: {
      example: {
        id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        name: 'June Cup',
        currency: 'USD',
        startsAt: '2030-06-01T00:00:00.000Z',
        endsAt: '2030-06-30T23:59:59.999Z',
        status: 'OPEN',
        finalizedAt: null,
        createdAt: '2030-05-20T10:00:00.000Z',
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid payload, endsAt not after startsAt, or endsAt in the past' })
  create(@Body() dto: CreateTournamentDto) {
    return this.tournaments.create(dto);
  }

  @Get(':id/leaderboard')
  @ApiOperation({ summary: 'Page of placements, score DESC (live from Redis, final from Postgres)' })
  @ApiOkResponse({
    description: 'Tied players share a placement; placements are absolute across pages.',
    schema: {
      example: {
        tournamentId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        status: 'OPEN',
        source: 'live',
        total: 3,
        limit: 50,
        offset: 0,
        items: [
          { placement: 1, playerId: 'carol', score: 550 },
          { placement: 1, playerId: 'alice', score: 550 },
          { placement: 3, playerId: 'bob', score: 500 },
        ],
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid id, limit or offset' })
  @ApiNotFoundResponse({ description: 'Unknown tournament' })
  leaderboard(@Param('id', ParseUUIDPipe) id: string, @Query() query: LeaderboardQueryDto) {
    return this.tournaments.getLeaderboard(id, query.limit, query.offset);
  }
}
