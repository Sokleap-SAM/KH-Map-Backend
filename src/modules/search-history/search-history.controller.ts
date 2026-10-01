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
import { SearchHistoryService } from './search-history.service';
import { AddSearchHistoryDto } from './dto/add-search-history.dto';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    role: string;
  };
}

@UseGuards(JwtAuthGuard)
@Controller('search-history')
export class SearchHistoryController {
  constructor(private readonly searchHistoryService: SearchHistoryService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.searchHistoryService.findByUser(req.user.userId);
  }

  @Post()
  add(@Req() req: AuthenticatedRequest, @Body() dto: AddSearchHistoryDto) {
    return this.searchHistoryService.add(req.user.userId, dto);
  }

  @Delete(':placeId')
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('placeId') placeId: string,
  ) {
    return this.searchHistoryService.remove(req.user.userId, placeId);
  }

  @Delete()
  clear(@Req() req: AuthenticatedRequest) {
    return this.searchHistoryService.clear(req.user.userId);
  }
}
