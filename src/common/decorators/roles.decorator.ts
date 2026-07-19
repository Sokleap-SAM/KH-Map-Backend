import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../modules/users/enums/role.enum';

export const Roles = (...roles: UserRole[]) => SetMetadata('roles', roles);
