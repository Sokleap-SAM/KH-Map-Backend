import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// App-issued JWT is the single session token for every sign-in path
// (email/password, Google, and Firebase one-click via POST /users/firebase-login).
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
