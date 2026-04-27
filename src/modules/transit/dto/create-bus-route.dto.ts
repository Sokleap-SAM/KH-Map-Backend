import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateBusRouteDto {
  @IsOptional()
  @IsBoolean()
  isLine?: boolean;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  status?: string;
}
