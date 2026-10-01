import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/enums/role.enum';
import { DriverService } from './driver.service';
import { DriverSetStatusDto } from './dto/driver-set-status.dto';
import { DriverStartTripDto } from './dto/driver-start-trip.dto';

// Every endpoint is scoped to the JWT-derived driverId (req.user.userId).
// Drivers cannot reference another driver's trips by ID — start/cancel run
// against trips of the bus assigned to them in admin.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.DRIVER)
@Controller('drivers/me')
export class DriverController {
  constructor(private readonly driverService: DriverService) {}

  /**
   * Driver profile + assigned bus. JWT doesn't carry `assignedBusId`
   * (it changes via admin reassign without re-login), so the dashboard
   * hits this on mount.
   */
  @Get()
  getMe(@CurrentUser() user: JwtUser) {
    return this.driverService.getProfile(user.userId);
  }

  /**
   * Trips on the driver's bus, partitioned today vs history. Frontend uses
   * this for the Trips tab — server-side filter so the driver never sees
   * (or even loads) other buses' trips.
   */
  @Get('trips')
  listMyTrips(@CurrentUser() user: JwtUser) {
    return this.driverService.listMyTrips(user.userId);
  }

  /** Toggle on-shift / off-shift. Off auto-cancels the active trip. */
  @Patch('status')
  setStatus(@CurrentUser() user: JwtUser, @Body() dto: DriverSetStatusDto) {
    return this.driverService.setStatus(user.userId, dto.status);
  }

  /** Start a pre-scheduled trip on the driver's assigned bus. */
  @Post('trips/start')
  startTrip(@CurrentUser() user: JwtUser, @Body() dto: DriverStartTripDto) {
    return this.driverService.startTrip(user.userId, dto.tripId);
  }

  /** Cancel the driver's currently-running trip (idempotent). */
  @Post('trips/cancel')
  cancelTrip(@CurrentUser() user: JwtUser) {
    return this.driverService.cancelActiveTrip(user.userId);
  }

  /**
   * Issue MQTT broker connection info. Rotates the password on every call —
   * the previous one is immediately invalid. Caller must store the returned
   * `password` (never shown again).
   */
  @Get('mqtt-credentials')
  getMqttCredentials(@CurrentUser() user: JwtUser) {
    return this.driverService.issueMqttCredentials(user.userId);
  }
}
