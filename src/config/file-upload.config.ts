import { CloudinaryStorage } from 'multer-storage-cloudinary';
import multer from 'multer';
import { cloudinary } from './cloudinary.config';

// 1. Create the Cloudinary Storage Engine
// This replaces the 'dest' or 'diskStorage' options used for local storage
export function createCloudinaryStorage(folderName: string) {
  return new CloudinaryStorage({
    cloudinary: cloudinary,
    params: () => {
      return {
        folder: `kh-map/${folderName}`,
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        transformation: [{ width: 1200, height: 800, crop: 'limit' }],
        // Cloudinary handles public_id automatically if left undefined,
        // which prevents naming collisions.
      };
    },
  });
}

// 3. Helper to delete image from Cloudinary
export async function deleteCloudinaryImage(imageUrl: string): Promise<void> {
  try {
    // Extracts the public ID from the Cloudinary URL
    const urlParts = imageUrl.split('/');
    const uploadIndex = urlParts.indexOf('upload');
    if (uploadIndex === -1) return;

    // Everything after 'v1234567/' and before the file extension
    const pathAfterVersion = urlParts.slice(uploadIndex + 2).join('/');
    const publicId = pathAfterVersion.replace(/\.[^/.]+$/, '');

    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.error('Error deleting Cloudinary image:', error);
  }
}

// 4. Integrated Multer Config
export function createUploadConfig(folderName: string) {
  return multer({
    storage: createCloudinaryStorage(folderName),
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB limit
    },
    fileFilter: (req, file, callback) => {
      const allowedTypes = /\.(jpg|jpeg|png|webp)$/i;
      if (!allowedTypes.test(file.originalname)) {
        return callback(new Error('Only image files are allowed!'));
      }
      callback(null, true);
    },
  });
}

// Export specific upload middlewares
export const placeUpload = createUploadConfig('places');
export const profileUpload = createUploadConfig('profiles');
