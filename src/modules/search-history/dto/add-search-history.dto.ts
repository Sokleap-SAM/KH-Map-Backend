import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class AddSearchHistoryDto {
  @IsString()
  @IsNotEmpty()
  placeId!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  categoryName?: string;

  @IsNumber()
  latitude!: number;

  @IsNumber()
  longitude!: number;
}
