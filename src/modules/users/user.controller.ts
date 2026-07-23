import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Param,
  Patch,
  Request as Req,
} from '@nestjs/common';
import { Request } from 'express';
import { Types } from 'mongoose';
import { UsersService } from './user.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from './enums/role.enum';
import { Roles } from '../../common/decorators/roles.decorator';
import { SetRoleDto } from './dto/set-role.dto';
import { AssignBusDto } from './dto/assign-bus.dto';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    role: string;
  };
}
@Controller('users')
export class UsersController {
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin-dashboard')
  getAdminData() {
    return { message: 'Welcome, Boss. Here is your money' };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.USER, UserRole.ADMIN)
  @Get('profile')
  getProfile(@Req() req: AuthenticatedRequest) {
    return req.user;
  }

  constructor(private readonly usersService: UsersService) {}

  @Post('register')
  async register(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @Post('verify')
  async verify(@Body('email') email: string, @Body('otp') otp: string) {
    return this.usersService.verifyRegistration(email, otp);
  }

  @Post('resend-code')
  async resendCode(@Body('email') email: string) {
    return this.usersService.resendVerificationCode(email);
  }

  @Post('google-login')
  async googleLogin(@Body('idToken') idToken: string) {
    return this.usersService.googleLogin(idToken);
  }

  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    return this.usersService.login(loginDto);
  }

  @Post('forgot-password')
  async forgotPassword(@Body('email') email: string) {
    return this.usersService.forgotPassword(email);
  }

  @Post('reset-password')
  async resetPassword(
    @Body('email') email: string,
    @Body('otp') otp: string,
    @Body('newPassword') newPassword: string,
  ) {
    return this.usersService.resetPassword(email, otp, newPassword);
  }

  // ─── Admin: role + driver assignment ──────────────────────────────────────

  /** Promote/demote a user. Demoting a driver auto-unassigns their bus. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('admin/users/:id/role')
  setUserRole(@Param('id') id: string, @Body() dto: SetRoleDto) {
    return this.usersService.setRole(new Types.ObjectId(id), dto.role);
  }

  /**
   * Bind/unbind a driver to a bus. Pass `{ busId: null }` (or omit) to
   * unassign. Throws ConflictException if the bus is already bound to a
   * different driver — unassign that one first.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('admin/drivers/:id/assign-bus')
  assignBus(@Param('id') id: string, @Body() dto: AssignBusDto) {
    return this.usersService.assignBusToDriver(
      new Types.ObjectId(id),
      dto.busId ? new Types.ObjectId(dto.busId) : null,
    );
  }
}
