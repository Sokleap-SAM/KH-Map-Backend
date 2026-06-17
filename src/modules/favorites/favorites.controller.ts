import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Request as Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { FavoritesService } from './favorites.service';
import { AddFavoriteDto } from './dto/add-favorite.dto';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    role: string;
  };
}

@UseGuards(JwtAuthGuard)
@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.favoritesService.findByUser(req.user.userId);
  }

  @Post()
  add(@Req() req: AuthenticatedRequest, @Body() dto: AddFavoriteDto) {
    return this.favoritesService.add(req.user.userId, dto);
  }

  @Delete(':placeId')
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('placeId') placeId: string,
  ) {
    return this.favoritesService.remove(req.user.userId, placeId);
  }

  @Delete()
  clear(@Req() req: AuthenticatedRequest) {
    return this.favoritesService.clear(req.user.userId);
  }
}
