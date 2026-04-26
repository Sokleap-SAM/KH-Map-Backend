import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Place, PlaceDocument } from './entities/place.schema';
import { CreatePlaceDto } from './dto/create-place.dto';
import { UpdatePlaceDto } from './dto/update-place.dto';
import { deleteCloudinaryImage } from '../../config/file-upload.config';

interface CloudinaryFile extends Express.Multer.File {
  path: string;
}

@Injectable()
export class PlaceService {
  constructor(
    @InjectModel(Place.name)
    private readonly placeModel: Model<PlaceDocument>,
  ) {}

  async create(
    dto: CreatePlaceDto,
    files?: Express.Multer.File[],
  ): Promise<Place> {
    const photos = files?.map((file) => (file as CloudinaryFile).path) ?? [];
    return this.placeModel.create({ ...dto, photos });
  }

  async findAll(): Promise<Place[]> {
    return this.placeModel.find().populate('category').exec();
  }

  async findOne(id: Types.ObjectId): Promise<Place> {
    const place = await this.placeModel
      .findById(id)
      .populate('category')
      .exec();
    if (!place) throw new NotFoundException(`Place ${id.toString()} not found`);
    return place;
  }

  async update(
    id: Types.ObjectId,
    dto: UpdatePlaceDto,
    files?: Express.Multer.File[],
  ): Promise<Place> {
    const updateData: UpdatePlaceDto & { photos?: string[] } = { ...dto };

    if (files && files.length > 0) {
      const existing = await this.placeModel.findById(id).exec();
      if (!existing)
        throw new NotFoundException(`Place ${id.toString()} not found`);

      // Delete old photos from Cloudinary
      await Promise.all(
        existing.photos.map((url) => deleteCloudinaryImage(url)),
      );

      updateData.photos = files.map((file) => (file as CloudinaryFile).path);
    }

    const place = await this.placeModel
      .findByIdAndUpdate(id, updateData, { new: true })
      .populate('category')
      .exec();
    if (!place) throw new NotFoundException(`Place ${id.toString()} not found`);
    return place;
  }

  async remove(id: Types.ObjectId): Promise<void> {
    const place = await this.placeModel.findById(id).exec();
    if (!place) throw new NotFoundException(`Place ${id.toString()} not found`);

    // Delete photos from Cloudinary
    await Promise.all(place.photos.map((url) => deleteCloudinaryImage(url)));

    await this.placeModel.findByIdAndDelete(id).exec();
  }
}
