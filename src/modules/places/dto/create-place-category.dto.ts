import { IsNotEmpty, IsString } from 'class-validator';

export class CreatePlaceCategoryDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}
