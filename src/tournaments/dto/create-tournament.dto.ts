import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsCurrencyCode } from './is-currency-code.decorator';
import { IsIsoDateTime } from './is-iso-date-time.decorator';

export class CreateTournamentDto {
  @ApiProperty({ example: 'June Cup', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: '2030-06-01T00:00:00.000Z', format: 'date-time' })
  @IsIsoDateTime()
  startsAt: string;

  @ApiProperty({ example: '2030-06-30T23:59:59.999Z', format: 'date-time' })
  @IsIsoDateTime()
  endsAt: string;

  /** Only bets in this currency count towards the tournament. */
  @ApiPropertyOptional({ example: 'USD', default: 'USD', pattern: '^[A-Z]{3}$' })
  @IsOptional()
  @IsCurrencyCode()
  currency?: string;
}
