import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { UserRole } from 'src/modules/users/enums/role.enums';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    role: UserRole;
  };
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // 1. What level is required for this door guard? admin or user
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      'roles',
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles) return true; //if no level required let the user in

    // 2. What level is the user?
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    // 3. check if their level matches the required
    return requiredRoles.some((role) => user.role?.includes(role));
  }
}
