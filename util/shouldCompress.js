function shouldCompress(imageType, size) {
  // If it's not an image, don't touch it
  if (!imageType.startsWith("image")) return false;
  
  // If it's smaller than 1KB (1024 bytes), ignore it 
  if (size < 1024) return false; 
  
  // Otherwise, compress everything
  return true; 
}

module.exports = shouldCompress;
