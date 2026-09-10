// ovalcrop — frame a head into the uploader's oval guide, headlessly.
//
// Reproduces what a barber does by hand in OvalCropperView: pan and pinch until
// the head fills the brass oval. The oval geometry is lifted from that view so
// the output is framed exactly the way the app would frame it:
//
//   cx = w/2, cy = h*0.43, rx = w*0.42, ry = h*0.38   in a 4:5 frame
//
// Vision finds the face; the head is the face box grown outward (hair above,
// jaw below), because a face rectangle stops at the hairline and framing to it
// would sit the crop too low. Profile shots often defeat face detection, so
// saliency is the fallback — which is the case that matters here, since one of
// these photos is shot from behind.
//
// Writes the 1280x1600 JPEG the pipeline expects, plus a proof image with the
// oval drawn over it so the framing can be checked before anything is posted.

import AppKit
import Vision
import CoreImage

let OUT_W: CGFloat = 1280
let OUT_H: CGFloat = 1600

// The guide, straight out of OvalCropperView.
let OVAL_CX = OUT_W / 2
let OVAL_CY = OUT_H * 0.43
let OVAL_RX = OUT_W * 0.42
let OVAL_RY = OUT_H * 0.38

struct Args {
    let input: String
    let output: String
    let proof: String
    /// Nudges the head box up or down as a fraction of head height, for when the
    /// automatic guess needs a human correction.
    let yNudge: CGFloat
    let fill: CGFloat
    /// Move the CONTENT within the frame, in output pixels. Positive dx pushes
    /// the subject right, positive dy pushes it down. This is the equivalent of
    /// the barber dragging the photo under the oval, and it's needed because a
    /// face-centred box under-reads a head that's turned away.
    let dx: CGFloat
    let dy: CGFloat
}

func parseArgs() -> Args {
    var input = "", output = "", proof = ""
    var yNudge: CGFloat = 0, fill: CGFloat = 0.98
    var dx: CGFloat = 0, dy: CGFloat = 0
    var i = 1
    let a = CommandLine.arguments
    while i < a.count {
        switch a[i] {
        case "--in": input = a[i+1]; i += 2
        case "--out": output = a[i+1]; i += 2
        case "--proof": proof = a[i+1]; i += 2
        case "--nudge": yNudge = CGFloat(Double(a[i+1]) ?? 0); i += 2
        case "--fill": fill = CGFloat(Double(a[i+1]) ?? 0.98); i += 2
        case "--dx": dx = CGFloat(Double(a[i+1]) ?? 0); i += 2
        case "--dy": dy = CGFloat(Double(a[i+1]) ?? 0); i += 2
        default: i += 1
        }
    }
    return Args(input: input, output: output, proof: proof, yNudge: yNudge, fill: fill, dx: dx, dy: dy)
}

let args = parseArgs()

guard let nsImage = NSImage(contentsOfFile: args.input),
      let tiff = nsImage.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let cgImage = rep.cgImage else {
    FileHandle.standardError.write("could not read \(args.input)\n".data(using: .utf8)!)
    exit(1)
}

let imgW = CGFloat(cgImage.width)
let imgH = CGFloat(cgImage.height)

// ── Find the head ─────────────────────────────────────────────────────────

/// Vision reports normalised coordinates with the origin at BOTTOM-left; every
/// box below is converted to top-left pixel space immediately so nothing further
/// down has to remember which convention it's in.
func toPixels(_ n: CGRect) -> CGRect {
    CGRect(x: n.minX * imgW,
           y: (1 - n.maxY) * imgH,
           width: n.width * imgW,
           height: n.height * imgH)
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

var headBox: CGRect?
var source = "none"

let faceRequest = VNDetectFaceRectanglesRequest()
try? handler.perform([faceRequest])
if let face = (faceRequest.results ?? []).max(by: { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height }) {
    let f = toPixels(face.boundingBox)
    // A face box runs brow-to-chin. The head is taller and wider: hair sits well
    // above it and the skull is broader than the face. These multipliers are the
    // difference between framing a head and framing a face floating low in the
    // oval.
    let grownTop = f.height * 0.85
    let grownBottom = f.height * 0.18
    let grownSide = f.width * 0.28
    headBox = CGRect(x: f.minX - grownSide,
                     y: f.minY - grownTop,
                     width: f.width + grownSide * 2,
                     height: f.height + grownTop + grownBottom)
    source = "face"
}

if headBox == nil {
    // Profile and back-of-head shots defeat face detection. Saliency finds what
    // the photo is ABOUT, which for these is the head.
    let saliency = VNGenerateAttentionBasedSaliencyImageRequest()
    try? handler.perform([saliency])
    if let obs = saliency.results?.first as? VNSaliencyImageObservation,
       let salient = obs.salientObjects?.max(by: { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height }) {
        headBox = toPixels(salient.boundingBox)
        source = "saliency"
    }
}

guard var head = headBox else {
    FileHandle.standardError.write("no head found\n".data(using: .utf8)!)
    exit(2)
}

// Optional human correction.
head = head.offsetBy(dx: 0, dy: head.height * args.yNudge)

// ── Fit the head into the oval ────────────────────────────────────────────

let targetH = OVAL_RY * 2 * args.fill
let targetW = OVAL_RX * 2 * args.fill

// Output pixels per source pixel.
var scale = min(targetH / head.height, targetW / head.width)

// The crop must sit inside the image, which sets a floor on the zoom.
scale = max(scale, OUT_W / imgW, OUT_H / imgH)

let cropW = OUT_W / scale
let cropH = OUT_H / scale

// Put the head's centre on the oval's centre.
let headCX = head.midX
let headCY = head.midY
// Moving the content right means moving the crop window left.
var cropX = headCX - OVAL_CX / scale - args.dx / scale
var cropY = headCY - OVAL_CY / scale - args.dy / scale

// Keep it on the image.
cropX = max(0, min(cropX, imgW - cropW))
cropY = max(0, min(cropY, imgH - cropH))

let cropRect = CGRect(x: cropX.rounded(), y: cropY.rounded(),
                      width: cropW.rounded(), height: cropH.rounded())

print("  source image : \(Int(imgW))x\(Int(imgH))")
print("  head found by: \(source)")
print("  head box     : x=\(Int(head.minX)) y=\(Int(head.minY)) w=\(Int(head.width)) h=\(Int(head.height))")
print("  crop         : x=\(Int(cropRect.minX)) y=\(Int(cropRect.minY)) w=\(Int(cropRect.width)) h=\(Int(cropRect.height))")
print("  head fills   : \(Int(head.height * scale / (OVAL_RY * 2) * 100))% of oval height, \(Int(head.width * scale / (OVAL_RX * 2) * 100))% of width")

// ── Render ────────────────────────────────────────────────────────────────

func render(withOval: Bool) -> CGImage? {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let ctx = CGContext(data: nil, width: Int(OUT_W), height: Int(OUT_H),
                              bitsPerComponent: 8, bytesPerRow: 0, space: space,
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }

    // Ink backdrop, matching the app's export.
    ctx.setFillColor(CGColor(red: 26/255, green: 26/255, blue: 24/255, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: OUT_W, height: OUT_H))

    // CGContext is bottom-left origin; flip the crop's y for the draw.
    let flippedY = imgH - cropRect.maxY
    guard let cropped = cgImage.cropping(to: CGRect(x: cropRect.minX, y: flippedY,
                                                    width: cropRect.width, height: cropRect.height))
    else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(cropped, in: CGRect(x: 0, y: 0, width: OUT_W, height: OUT_H))

    if withOval {
        // The guide, drawn so the framing can be judged rather than trusted.
        let ovalRect = CGRect(x: OVAL_CX - OVAL_RX, y: OUT_H - OVAL_CY - OVAL_RY,
                              width: OVAL_RX * 2, height: OVAL_RY * 2)
        ctx.setStrokeColor(CGColor(red: 186/255, green: 168/255, blue: 139/255, alpha: 1))
        ctx.setLineWidth(4)
        ctx.strokeEllipse(in: ovalRect)
    }
    return ctx.makeImage()
}

func write(_ image: CGImage, to path: String, quality: CGFloat) {
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: quality]) else { return }
    try? data.write(to: URL(fileURLWithPath: path))
}

if let out = render(withOval: false) { write(out, to: args.output, quality: 0.92) }
if !args.proof.isEmpty, let proof = render(withOval: true) { write(proof, to: args.proof, quality: 0.9) }
print("  wrote        : \(args.output)")
