import { IsMongoId } from 'class-validator';

export class DriverStartTripDto {
  @IsMongoId()
  tripId!: string;
}
