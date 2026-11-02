//! Synchronous PNG/JPEG decoding for the NGI image decoder (iid 0xc02). The game expects
//! tightly packed BGR888 rows (see hle_ngi.decode_image in the Python prototype).

pub struct Decoded {
    pub width: u32,
    pub height: u32,
    pub bgr: Vec<u8>,
}

pub fn decode(data: &[u8]) -> Option<Decoded> {
    if data.starts_with(b"\x89PNG") {
        decode_png(data)
    } else if data.starts_with(&[0xFF, 0xD8]) {
        decode_jpeg(data)
    } else {
        None
    }
}

fn decode_png(data: &[u8]) -> Option<Decoded> {
    let mut dec = png::Decoder::new(data);
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = dec.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let (w, h) = (info.width, info.height);
    let px = &buf[..info.buffer_size()];
    let mut bgr = Vec::with_capacity((w * h * 3) as usize);
    match info.color_type {
        png::ColorType::Rgb => px.chunks_exact(3).for_each(|p| bgr.extend_from_slice(&[p[2], p[1], p[0]])),
        png::ColorType::Rgba => px.chunks_exact(4).for_each(|p| bgr.extend_from_slice(&[p[2], p[1], p[0]])),
        png::ColorType::Grayscale => px.iter().for_each(|&g| bgr.extend_from_slice(&[g, g, g])),
        png::ColorType::GrayscaleAlpha => px.chunks_exact(2).for_each(|p| bgr.extend_from_slice(&[p[0], p[0], p[0]])),
        png::ColorType::Indexed => return None, // EXPAND turns palettes into RGB(A)
    }
    Some(Decoded { width: w, height: h, bgr })
}

fn decode_jpeg(data: &[u8]) -> Option<Decoded> {
    let mut dec = jpeg_decoder::Decoder::new(data);
    let px = dec.decode().ok()?;
    let info = dec.info()?;
    let (w, h) = (info.width as u32, info.height as u32);
    let mut bgr = Vec::with_capacity((w * h * 3) as usize);
    match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => px.chunks_exact(3).for_each(|p| bgr.extend_from_slice(&[p[2], p[1], p[0]])),
        jpeg_decoder::PixelFormat::L8 => px.iter().for_each(|&g| bgr.extend_from_slice(&[g, g, g])),
        _ => return None,
    }
    Some(Decoded { width: w, height: h, bgr })
}
