import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, Max, MaxLength, Min } from 'class-validator';
import { IsCurrencyCode } from './is-currency-code.decorator';
import { IsIsoDateTime } from './is-iso-date-time.decorator';

export class CreateBetDto {
  @ApiProperty({ example: 'bet_123456', maxLength: 255, description: 'Idempotency key' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  externalBetId: string;

  @ApiProperty({ example: 'player_42', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  playerId: string;

  /** Amount in minor units (cents). */
  @ApiProperty({ example: 250, minimum: 1, maximum: 2_147_483_647, description: 'Cents: 250 = $2.50' })
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  amount: number;

  @ApiProperty({ example: 'USD', pattern: '^[A-Z]{3}$' })
  @IsCurrencyCode()
  currency: string;

  @ApiProperty({ example: '2030-06-04T12:30:00.000Z', format: 'date-time' })
  @IsIsoDateTime()
  createdAt: string;
}
