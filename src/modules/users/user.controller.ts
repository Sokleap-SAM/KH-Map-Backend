import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Param,
  Patch,
  Delete,
  Query,
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
import { AdminCreateUserDto } from './dto/admin-create-user.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';

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

  /**
   * The caller's own profile, read fresh from the database.
   *
   * Previously this returned `req.user` — the decoded JWT payload — so it could
   * not report `status`, `assignedBusId`, `isVerified` or `createdAt`, and a
   * role changed by an admin kept showing the old value until the user logged
   * in again.
   *
   * Guarded by JwtAuthGuard alone: this is "my own profile", so every
   * authenticated role qualifies. The previous `@Roles(USER, ADMIN)` excluded
   * drivers from reading their own record.
   */
  @UseGuards(JwtAuthGuard)
  @Get('profile')
  getProfile(@Req() req: AuthenticatedRequest) {
    return this.usersService.findOnePublic(new Types.ObjectId(req.user.userId));
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

  // One-click sign-in: frontend sends the Firebase ID token it obtained from
  // the Firebase client SDK; we verify it, provision the user, and return our
  // own { access_token, user }.
  @Post('firebase-login')
  async firebaseLogin(@Body('idToken') idToken: string) {
    return this.usersService.firebaseLogin(idToken);
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

  // ─── CRUD ─────────────────────────────────────────────────────────────────
  //
  // Route order matters here. Nest matches in declaration order, so the literal
  // paths ('me', and 'profile'/'admin-dashboard' at the top of this class) must
  // be declared before `:id` — otherwise `GET /users/profile` would be captured
  // by `GET /users/:id` and try to look up a user with the id "profile".

  /**
   * Update your own profile. Deliberately narrow: name and password only.
   * Role, status and email are not self-editable — see UpdateProfileDto.
   */
  @UseGuards(JwtAuthGuard)
  @Patch('me')
  updateOwnProfile(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateOwnProfile(
      new Types.ObjectId(req.user.userId),
      dto,
    );
  }

  /**
   * Create a user directly, already verified — the onboarding path for drivers,
   * who would otherwise have to self-register, wait for an OTP email, and then
   * be promoted in a second call.
   *
   * POST /users/admin
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('admin')
  adminCreateUser(@Body() dto: AdminCreateUserDto) {
    return this.usersService.adminCreate(dto);
  }

  /**
   * Paginated user list, filterable by role and status and searchable by name
   * or email. Without this an admin has no way to discover the ids that every
   * other admin endpoint takes.
   *
   * GET /users?page=1&limit=20&role=driver&search=sok
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get()
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.usersService.findAll(query);
  }

  /** GET /users/:id */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get(':id')
  findOneUser(@Param('id') id: string) {
    return this.usersService.findOnePublic(new Types.ObjectId(id));
  }

  /**
   * Admin edit of any user. A role change here runs the same demotion logic as
   * the dedicated role endpoint, so an ex-driver's bus link is cleared on both
   * sides rather than left dangling.
   *
   * PATCH /users/:id
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id')
  adminUpdateUser(@Param('id') id: string, @Body() dto: AdminUpdateUserDto) {
    return this.usersService.adminUpdate(new Types.ObjectId(id), dto);
  }

  /**
   * Delete a user. Refuses to delete yourself, the last remaining admin, or a
   * driver with a trip in progress — each of those leaves a state you cannot
   * recover from through the API.
   *
   * DELETE /users/:id
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Delete(':id')
  removeUser(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.usersService.remove(new Types.ObjectId(id), req.user.userId);
  }
}
