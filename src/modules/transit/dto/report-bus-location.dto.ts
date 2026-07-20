import {
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export class ReportBusLocationDto {
  @IsMongoId()
  @IsNotEmpty()
  busId!: string;

  @IsMongoId()
  @IsNotEmpty()
  tripId!: string;

  @IsMongoId()
  @IsNotEmpty()
  routeId!: string;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  /** Compass heading in degrees (0-360), optional */
  @IsNumber()
  @Min(0)
  @Max(360)
  @IsOptional()
  heading?: number;

  /** Current speed in km/h, optional */
  @IsNumber()
  @Min(0)
  @IsOptional()
  speed?: number;

  /** Index of the last stop the bus departed from, used for ETA accuracy. */
  @IsNumber()
  @Min(0)
  @IsOptional()
  currentStopIndex?: number;

  /**
   * For parked/queued buses: wall-clock ms at which this bus is expected to
   * depart stop 0. Routing adds the remaining wait to every downstream stop
   * ETA so users see "Bus in N min" inclusive of the queue delay.
   */
  @IsNumber()
  @Min(0)
  @IsOptional()
  notDepartingUntilMs?: number;
}
