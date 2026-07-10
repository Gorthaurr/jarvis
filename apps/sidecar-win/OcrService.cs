// §Волна2 (2.3) — Локальный OCR через Windows.Media.Ocr (zero-dep на Win10+).
//
// Дешёвые «глаза» для canvas/игр/видео, где UIA слепа: клиент снимает экран (Electron
// desktopCapturer, при надобности кропом региона), шлёт PNG base64 → сайдкар распознаёт
// текст локально (~50-200 токенов текста вместо 1.5-2K-токенного vision-раунда LLM).
// bbox строк — В КООРДИНАТАХ ПЕРЕДАННОГО ИЗОБРАЖЕНИЯ (клиент сам переводит в экранные).
//
// ЧЕСТНОСТЬ: нет OCR-языка/движка → ошибка (не пустой «успех»); пустой текст = честный
// результат «текста не найдено» (различимо вызывающим).

using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace SidecarWin;

public static class OcrService
{
    /// <summary>Распознать текст на изображении (PNG/JPEG base64). lang — BCP-47 ("ru"/"en"), null = язык профиля.</summary>
    public static async Task<OcrReadResult> RecognizeAsync(OcrArgs args)
    {
        if (string.IsNullOrWhiteSpace(args.ImageB64))
            throw new ArgumentException("ocr: пустое изображение (imageB64)");

        byte[] bytes = Convert.FromBase64String(args.ImageB64);

        using var stream = new InMemoryRandomAccessStream();
        await stream.WriteAsync(bytes.AsBuffer());
        stream.Seek(0);

        BitmapDecoder decoder = await BitmapDecoder.CreateAsync(stream);
        using SoftwareBitmap bmp = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);

        if (bmp.PixelWidth > OcrEngine.MaxImageDimension || bmp.PixelHeight > OcrEngine.MaxImageDimension)
            throw new InvalidOperationException(
                $"ocr: изображение {bmp.PixelWidth}x{bmp.PixelHeight} больше лимита движка {OcrEngine.MaxImageDimension}px");

        OcrEngine engine = CreateEngine(args.Lang);
        Windows.Media.Ocr.OcrResult result = await engine.RecognizeAsync(bmp);

        var lines = new List<OcrLineDto>(result.Lines.Count);
        foreach (OcrLine l in result.Lines)
        {
            // bbox строки = объединение прямоугольников её слов (у OcrLine собственного rect нет).
            double x0 = double.MaxValue, y0 = double.MaxValue, x1 = double.MinValue, y1 = double.MinValue;
            foreach (OcrWord w in l.Words)
            {
                x0 = Math.Min(x0, w.BoundingRect.X);
                y0 = Math.Min(y0, w.BoundingRect.Y);
                x1 = Math.Max(x1, w.BoundingRect.X + w.BoundingRect.Width);
                y1 = Math.Max(y1, w.BoundingRect.Y + w.BoundingRect.Height);
            }
            bool hasBox = l.Words.Count > 0;
            lines.Add(new OcrLineDto(
                Text: l.Text,
                X: hasBox ? x0 : 0,
                Y: hasBox ? y0 : 0,
                W: hasBox ? x1 - x0 : 0,
                H: hasBox ? y1 - y0 : 0));
        }

        return new OcrReadResult(result.Text ?? "", lines);
    }

    /// <summary>Движок: явный язык → профиль пользователя → ru → en. Нет ни одного → честная ошибка.</summary>
    private static OcrEngine CreateEngine(string? lang)
    {
        OcrEngine? engine = null;
        if (!string.IsNullOrWhiteSpace(lang))
        {
            try { engine = OcrEngine.TryCreateFromLanguage(new Language(lang)); }
            catch { engine = null; }
        }
        engine ??= OcrEngine.TryCreateFromUserProfileLanguages();
        try { engine ??= OcrEngine.TryCreateFromLanguage(new Language("ru")); } catch { /* нет пакета */ }
        try { engine ??= OcrEngine.TryCreateFromLanguage(new Language("en")); } catch { /* нет пакета */ }
        return engine
            ?? throw new InvalidOperationException("ocr: OCR-движок недоступен (нет языковых пакетов Windows OCR)");
    }
}
