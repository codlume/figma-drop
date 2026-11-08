// Renders the DMG window background at 1x and 2x from layout.json, which scripts/dmg.mjs also
// reads for the window size and icon positions. The PNGs are committed, so builds never run this.
//
//   swift apps/desktop/dmg/render-background.swift apps/desktop/dmg
import CoreGraphics
import CoreText
import Foundation
import ImageIO

struct Point: Decodable { let x: Double; let y: Double }
struct Size: Decodable { let width: Double; let height: Double }
struct Layout: Decodable {
  let window: Size
  let iconSize: Double
  let icons: [String: Point]
  let hint: String
}

let dir = URL(fileURLWithPath: CommandLine.arguments[1])
let layout = try JSONDecoder().decode(
  Layout.self, from: Data(contentsOf: dir.appendingPathComponent("layout.json")))
guard let app = layout.icons["figma-drop.app"], let applications = layout.icons["Applications"]
else { fatalError("layout.json needs figma-drop.app and Applications icons") }

func color(_ hex: UInt32) -> CGColor {
  CGColor(
    srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}

func render(scale: Int, to url: URL) {
  let s = CGFloat(scale)
  let width = Int(layout.window.width) * scale
  let height = Int(layout.window.height) * scale
  let context = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  // Finder places icons from the top-left corner, so the drawing uses the same origin.
  context.translateBy(x: 0, y: CGFloat(height))
  context.scaleBy(x: s, y: -s)

  context.setFillColor(color(0xF4F3F0))
  context.fill(CGRect(x: 0, y: 0, width: layout.window.width, height: layout.window.height))

  let gap = layout.iconSize / 2 + 30
  let start = app.x + gap
  let end = applications.x - gap
  let y = app.y
  context.setStrokeColor(color(0xA19D96))
  context.setLineWidth(3)
  context.setLineCap(.round)
  context.setLineJoin(.round)
  context.move(to: CGPoint(x: start, y: y))
  context.addLine(to: CGPoint(x: end, y: y))
  context.move(to: CGPoint(x: end - 13, y: y - 12))
  context.addLine(to: CGPoint(x: end, y: y))
  context.addLine(to: CGPoint(x: end - 13, y: y + 12))
  context.strokePath()

  let font = CTFontCreateUIFontForLanguage(.system, 15, nil)!
  let text = NSAttributedString(
    string: layout.hint,
    attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): color(0x6E6A63),
    ])
  let line = CTLineCreateWithAttributedString(text)
  let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
  context.saveGState()
  // CoreText draws with a bottom-left origin, so the text is flipped back locally.
  context.translateBy(x: (layout.window.width - bounds.width) / 2, y: layout.window.height - 58)
  context.scaleBy(x: 1, y: -1)
  context.textPosition = .zero
  CTLineDraw(line, context)
  context.restoreGState()

  let image = context.makeImage()!
  let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
  // The DPI marks the 2x file as HiDPI for `tiffutil -cathidpicheck`, which dmgbuild runs.
  let dpi = 72 * scale
  CGImageDestinationAddImage(
    destination, image,
    [kCGImagePropertyDPIWidth: dpi, kCGImagePropertyDPIHeight: dpi] as CFDictionary)
  guard CGImageDestinationFinalize(destination) else { fatalError("could not write \(url.path)") }
  print("Wrote \(url.path) \(width)x\(height)")
}

render(scale: 1, to: dir.appendingPathComponent("background.png"))
render(scale: 2, to: dir.appendingPathComponent("background@2x.png"))
