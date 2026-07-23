import { Injectable } from '@nestjs/common';
import { FirebaseAuthGuard } from './firebase-auth.guard';

@Injectable()
export class JwtAuthGuard extends FirebaseAuthGuard {}
