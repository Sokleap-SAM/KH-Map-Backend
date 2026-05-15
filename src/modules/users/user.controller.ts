import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Request as Req,
} from '@nestjs/common';
import { Request } from 'express';
import { UsersService } from './user.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from './enums/role.enum';
import { Roles } from '../../common/decorators/roles.decorator';

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
}
