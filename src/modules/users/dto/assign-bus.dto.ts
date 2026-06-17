import { IsMongoId, IsOptional } from 'class-validator';

export class AssignBusDto {
  // null/absent = unassign
  @IsOptional()
  @IsMongoId()
  busId?: string | null;
}
