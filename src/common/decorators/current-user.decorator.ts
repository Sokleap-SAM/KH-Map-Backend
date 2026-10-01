import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { UserRole } from '../../modules/users/enums/role.enum';

export interface JwtUser {
  userId: string;
  email: string;
  role: UserRole;
  name?: string;
}

interface AuthenticatedRequest extends Request {
  user: JwtUser;
}

// Pulls the JWT-derived user payload off the request. Use on any handler
// protected by JwtAuthGuard — the strategy populates `req.user`.
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtUser => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return req.user;
  },
);
