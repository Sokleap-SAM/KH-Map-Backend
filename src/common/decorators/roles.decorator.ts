import { SetMetadata } from '@nestjs/common';
import { UserRole } from 'src/modules/users/enums/role.enums';

export const Roles = (...roles: UserRole[]) => SetMetadata('roles', roles);
