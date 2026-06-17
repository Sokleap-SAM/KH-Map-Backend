import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/user.service';
import { UserRole } from '../users/enums/role.enum';

// Called by the Mosquitto go-auth plugin (HTTP backend) on every connect,
// publish, and subscribe. NOT a public API — protected by a shared secret
// passed in the `Authorization` header. Run the broker on an internal
// network or bind these routes to localhost only.
//
// Protocol reference:
//   https://github.com/iegomez/mosquitto-go-auth#http
//   acc: 1 = read, 2 = write, 3 = readwrite, 4 = subscribe
@Controller('internal/mqtt-auth')
export class MqttAuthController {
  constructor(
    private readonly usersService: UsersService,
    private readonly config: ConfigService,
  ) {}

  private assertInternalSecret(auth: string | undefined): void {
    const expected = this.config.get<string>('MQTT_AUTH_INTERNAL_SECRET');
    if (!expected) {
      // Fail closed when unconfigured — would otherwise grant the broker
      // unconditional access to user records.
      throw new ForbiddenException('MQTT auth not configured');
    }
    if (auth !== `Bearer ${expected}`) {
      throw new UnauthorizedException();
    }
  }

  // Validates the connect-time username/password. Username is the driver's
  // user _id; password is the plaintext last issued by /drivers/me/mqtt-credentials.
  // Also accepts a backend service account (used by the NestJS publisher) keyed
  // off MQTT_BACKEND_USERNAME / MQTT_BACKEND_PASSWORD env vars.
  @Post('user')
  @HttpCode(200)
  async checkUser(
    @Headers('authorization') auth: string,
    @Body() body: { username?: string; password?: string },
  ) {
    this.assertInternalSecret(auth);
    if (!body.username || !body.password) {
      throw new UnauthorizedException();
    }

    // Service account (backend publisher / subscriber).
    const backendUser = this.config.get<string>('MQTT_BACKEND_USERNAME');
    const backendPass = this.config.get<string>('MQTT_BACKEND_PASSWORD');
    if (
      backendUser &&
      backendPass &&
      body.username === backendUser &&
      body.password === backendPass
    ) {
      return { Ok: true };
    }

    // Driver account.
    let id: Types.ObjectId;
    try {
      id = new Types.ObjectId(body.username);
    } catch {
      throw new UnauthorizedException();
    }
    const user = await this.usersService.findRawById(id);
    if (!user || user.role !== UserRole.DRIVER || !user.mqttPasswordHash) {
      throw new UnauthorizedException();
    }
    const ok = await bcrypt.compare(body.password, user.mqttPasswordHash);
    if (!ok) throw new UnauthorizedException();
    return { Ok: true };
  }

  // Returns 200 only for the backend service account — drivers must never be
  // superusers (they'd be able to bypass ACL entirely).
  @Post('superuser')
  @HttpCode(200)
  checkSuperuser(
    @Headers('authorization') auth: string,
    @Body() body: { username?: string },
  ) {
    this.assertInternalSecret(auth);
    const backendUser = this.config.get<string>('MQTT_BACKEND_USERNAME');
    if (backendUser && body.username === backendUser) {
      return { Ok: true };
    }
    throw new ForbiddenException();
  }

  // Per-action permission check. Drivers may only WRITE to their own
  // `driver/<their-id>/location` topic; reads and subscribes for drivers
  // are denied. Riders/anonymous reads are handled by the broker's
  // anonymous read pattern, not here.
  @Post('acl')
  @HttpCode(200)
  checkAcl(
    @Headers('authorization') auth: string,
    @Body()
    body: { username?: string; topic?: string; acc?: number },
  ) {
    this.assertInternalSecret(auth);
    if (!body.username || !body.topic || typeof body.acc !== 'number') {
      throw new ForbiddenException();
    }
    // 2 = write, 3 = readwrite. Drivers only need write.
    const isWrite = body.acc === 2 || body.acc === 3;
    if (!isWrite) throw new ForbiddenException();

    const expected = `driver/${body.username}/location`;
    if (body.topic !== expected) throw new ForbiddenException();
    return { Ok: true };
  }
}
