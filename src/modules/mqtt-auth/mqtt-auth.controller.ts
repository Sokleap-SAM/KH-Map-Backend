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

  /**
   * Verify the shared secret the broker presents on every auth request.
   *
   * Accepted in EITHER header, because mosquitto-go-auth cannot send an
   * Authorization one. Its HTTP backend sets exactly two headers,
   * Content-Type and User-Agent, and only User-Agent is configurable
   * (auth_opt_http_user_agent). There is no auth_opt_http_headers option in
   * any released version — a config using one is silently ignored, and every
   * request then arrives with no credential at all.
   *
   * So User-Agent is the channel the broker actually uses. Authorization is
   * still accepted: it is the conventional spelling, it keeps manual testing
   * with curl natural, and it means nothing here has to change if the plugin
   * ever grows real header support.
   */
  private assertInternalSecret(
    auth: string | undefined,
    userAgent: string | undefined,
  ): void {
    const expected = this.config.get<string>('MQTT_AUTH_INTERNAL_SECRET');
    if (!expected) {
      // Fail closed when unconfigured — would otherwise grant the broker
      // unconditional access to user records.
      throw new ForbiddenException('MQTT auth not configured');
    }
    if (auth === `Bearer ${expected}` || userAgent === expected) {
      return;
    }
    throw new UnauthorizedException();
  }

  // Validates the connect-time username/password. Username is the driver's
  // user _id; password is the plaintext last issued by /drivers/me/mqtt-credentials.
  // Also accepts a backend service account (used by the NestJS publisher) keyed
  // off MQTT_BACKEND_USERNAME / MQTT_BACKEND_PASSWORD env vars.
  //
  // Anonymous clients never reach this endpoint, and must never be granted by
  // it. Riders connect on the broker's 9001 listener, which loads no plugin, so
  // mosquitto authorises them from anonymous.acl without consulting the API at
  // all. Every request that does arrive here therefore belongs to a driver or
  // to the backend service account, and an empty username is malformed input.
  @Post('user')
  @HttpCode(200)
  async checkUser(
    @Headers('authorization') auth: string,
    @Headers('user-agent') userAgent: string,
    @Body() body: { username?: string; password?: string },
  ) {
    this.assertInternalSecret(auth, userAgent);
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
    @Headers('user-agent') userAgent: string,
    @Body() body: { username?: string },
  ) {
    this.assertInternalSecret(auth, userAgent);
    const backendUser = this.config.get<string>('MQTT_BACKEND_USERNAME');
    if (backendUser && body.username === backendUser) {
      return { Ok: true };
    }
    throw new ForbiddenException();
  }

  // Per-action permission check. Drivers may only WRITE to their own
  // `driver/<their-id>/location` topic; reads and subscribes for drivers are
  // denied.
  //
  // Rider reads are NOT handled here. They are granted by anonymous.acl on the
  // broker's plugin-free 9001 listener, so no anonymous request ever reaches
  // this endpoint — which is why an empty username is rejected rather than
  // treated as a rider.
  //
  // acc values from the go-auth protocol: 1 = read, 2 = write, 3 = readwrite,
  // 4 = subscribe.
  @Post('acl')
  @HttpCode(200)
  checkAcl(
    @Headers('authorization') auth: string,
    @Headers('user-agent') userAgent: string,
    @Body()
    body: { username?: string; topic?: string; acc?: number },
  ) {
    this.assertInternalSecret(auth, userAgent);
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
