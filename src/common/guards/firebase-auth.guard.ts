import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Request } from 'express';
import { UsersService } from '../../modules/users/user.service';

if (getApps().length === 0) {
  initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || 'khmapauth',
    credential: applicationDefault(),
  });
}

// 1. Explicitly type the Firebase decoded token fields we care about
interface DecodedFirebaseToken {
  email?: string;
  name?: string;
  uid: string;
}

// 2. Safely extend the standard Express Request type to support our user attachment
interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    email: string;
    role: string;
    name: string;
  };
}

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(private readonly usersService: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Cast the request into our custom structured AuthenticatedRequest interface
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // Safely extract the authorization header using a fallback check
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'លេខកូដផ្ទៀងផ្ទាត់មិនត្រូវបានផ្តល់ឱ្យទេ (No token provided)',
      );
    }

    const token = authHeader.split(' ')[1];
    try {
      // Initialize Firebase Admin check
      if (getApps().length === 0) {
        initializeApp({
          projectId: process.env.FIREBASE_PROJECT_ID || 'khmapauth',
        });
      }

      // 3. Force-cast the returned verification promise to our strict structure
      const decodedToken = (await getAuth().verifyIdToken(
        token,
      )) as unknown as DecodedFirebaseToken;

      const email = decodedToken.email?.trim().toLowerCase();
      if (!email) {
        throw new UnauthorizedException(
          'អ៊ីមែលក្នុង Token មិនត្រឹមត្រូវ (Email in token is missing)',
        );
      }

      // Find or auto-provision user in MongoDB
      const user = await this.usersService.findByEmail(email);
      let targetUser = user;

      if (!targetUser) {
        targetUser = await this.usersService.createFromFirebase({
          email,
          name: decodedToken.name || email.split('@')[0],
          firebaseUid: decodedToken.uid,
        });
      } else if (targetUser.firebaseUid !== decodedToken.uid) {
        targetUser.firebaseUid = decodedToken.uid;
        if (!targetUser.isVerified) {
          targetUser.isVerified = true;
        }
        await targetUser.save();
      }

      // 4. Attach user details safely without violating standard request objects
      request.user = {
        userId: (targetUser._id as { toString(): string }).toString(),
        email: targetUser.email,
        role: targetUser.role,
        name: targetUser.name,
      };

      return true;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      throw new UnauthorizedException(
        'លេខកូដផ្ទៀងផ្ទាត់មិនត្រឹមត្រូវ ឬហួសកំណត់ (Invalid or expired Firebase token)',
      );
    }
  }
}
