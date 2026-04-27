import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateBusDto {
  @IsString()
  @IsNotEmpty()
  busNumber!: string;

  @IsString()
  @IsNotEmpty()
  licensePlate!: string;

  @Transform(({ value }) => Number(value))
  @IsNumber()
  capacity!: number;

  @IsOptional()
  @IsString()
  status?: string;
}
