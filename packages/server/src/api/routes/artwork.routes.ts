import { Router } from 'express';
import { ArtworkService } from '../../services/artwork.service';

/**
 * Serves cached album artwork images safely.
 */
export function artworkRoutes(artworkService: ArtworkService = new ArtworkService()): Router {
  const router = Router();

  router.get('/:file', (req, res) => {
    const file = req.params.file;
    const filePath = artworkService.getFilePath(file);
    if (!filePath) {
      res.status(404).json({ error: 'Artwork not found' });
      return;
    }

    res.sendFile(filePath);
  });

  return router;
}
