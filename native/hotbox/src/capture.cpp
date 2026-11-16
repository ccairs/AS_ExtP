// capture.cpp — 合成预览图三动作实现
// 渲染链：ItemSuite9 取活动合成 + 当前时间 → RenderOptionsSuite3（8bpc/100%/拼合模式见
// renderActiveComp）→ RenderSuite5::AEGP_RenderAndCheckoutFrame → WorldSuite2 读像素
// （ARGB → BGRA 顶朝下拷贝）→ CheckinFrame 释放。
// 输出链：剪切板 = 注册格式 "PNG"（带 alpha）+ CF_DIB 回退；PNG/JPG 文件走 WIC
// （AE 主线程 COM STA 已就绪）。
#include "capture.h"
#include "aeexec.h"
#include "log.h"
#include "data.h"
#include "i18n.h"
#include <windows.h>
#include <wincodec.h>
#include <commdlg.h>
#include <shlobj.h>
#include <cstring>
#include <cstdio>
#include <cwctype>
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "comdlg32.lib")
#pragma comment(lib, "shell32.lib")

namespace capture {

bool renderActiveComp(Frame* out, std::string* err, bool keepAlpha) {
    if (err) err->clear();
    SPBasicSuite* sp = aeexec_sp();
    AEGP_PluginID id = aeexec_pluginId();
    if (!sp || !id) { if (err) *err = Tr(S_HOTBOX_CAPTURE_ERR_PLUGIN_NOT_INITIALIZED); return false; }
    AEGP_SuiteHandler suites(sp);
    auto* item = suites.ItemSuite9();
    auto* ro = suites.RenderOptionsSuite3();
    auto* rs = suites.RenderSuite5();
    auto* ws = suites.WorldSuite2();
    if (!item || !ro || !rs || !ws) { if (err) *err = Tr(S_HOTBOX_CAPTURE_ERR_AEGP_SUITES); return false; }

    AEGP_ItemH itemH = nullptr;
    if (item->AEGP_GetActiveItem(&itemH) != A_Err_NONE || !itemH) {
        if (err) *err = Tr(S_HOTBOX_CAPTURE_ERR_NO_ACTIVE_PROJECT);
        return false;
    }
    AEGP_ItemType type = AEGP_ItemType_NONE;
    item->AEGP_GetItemType(itemH, &type);
    if (type != AEGP_ItemType_COMP) {
        if (err) *err = Tr(S_HOTBOX_CAPTURE_ERR_ACTIVE_ITEM_NOT_COMP);
        return false;
    }
    // 合成名（保存默认文件名用；UTF-16 memhandle → UTF-8）
    AEGP_MemHandle nameH = nullptr;
    if (item->AEGP_GetItemName(id, itemH, &nameH) == A_Err_NONE && nameH) {
        void* p = nullptr;
        if (suites.MemorySuite1()->AEGP_LockMemHandle(nameH, &p) == A_Err_NONE && p) {
            out->compNameUtf8 = data::wideToUtf8(std::wstring((const wchar_t*)p));
            suites.MemorySuite1()->AEGP_UnlockMemHandle(nameH);
        }
        suites.MemorySuite1()->AEGP_FreeMemHandle(nameH);
    }
    // 当前时间（合成原生时间轴，即视图 CT）
    A_Time t = {};
    item->AEGP_GetItemCurrentTime(itemH, &t);

    AEGP_RenderOptionsH optH = nullptr;
    if (ro->AEGP_NewFromItem(id, itemH, &optH) != A_Err_NONE || !optH) {
        if (err) *err = Tr(S_HOTBOX_CAPTURE_ERR_RENDER_OPTIONS);
        return false;
    }
    ro->AEGP_SetTime(optH, t);
    ro->AEGP_SetWorldType(optH, AEGP_WorldType_8);
    ro->AEGP_SetDownsampleFactor(optH, 1, 1);                       // 100% 全分辨率
    // keepAlpha：STRAIGHT 保留合成自身 alpha 且 RGB 不预乘（剪切板 PNG 要的透明通道）；
    // 否则拼合到合成背景色 —— 观感对齐合成视图，与 PNG/JPG 保存的既有观感一致
    ro->AEGP_SetMatteMode(optH, keepAlpha ? AEGP_MatteMode_STRAIGHT
                                          : AEGP_MatteMode_PREMUL_BG_COLOR);
    AEGP_FrameReceiptH rcpt = nullptr;
    // UI 线程同步渲染（用户显式请求的场景，SDK 允许；>2s 自动弹进度框可取消）
    A_Err rerr = rs->AEGP_RenderAndCheckoutFrame(optH, nullptr, nullptr, &rcpt);
    ro->AEGP_Dispose(optH);
    if (rerr != A_Err_NONE || !rcpt) {
        if (err) *err = Tr(S_HOTBOX_CAPTURE_ERR_RENDER);
        return false;
    }

    bool ok = false;
    AEGP_WorldH world = nullptr;
    if (rs->AEGP_GetReceiptWorld(rcpt, &world) == A_Err_NONE && world) {
        A_long w = 0, h = 0;
        A_u_long rowBytes = 0;
        PF_Pixel8* base = nullptr;
        if (ws->AEGP_GetSize(world, &w, &h) == A_Err_NONE && w > 0 && h > 0 &&
            ws->AEGP_GetRowBytes(world, &rowBytes) == A_Err_NONE &&
            rowBytes >= (A_u_long)w * 4 &&
            ws->AEGP_GetBaseAddr8(world, &base) == A_Err_NONE && base) {
            out->w = (int)w;
            out->h = (int)h;
            out->px.assign((size_t)w * h * 4, 0);
            // PF_Pixel8 内存序 [A][R][G][B] → BGRA（顶朝下，行序即 world 行序）
            for (A_long y = 0; y < h; ++y) {
                const PF_Pixel8* src = (const PF_Pixel8*)((const unsigned char*)base +
                                                          (size_t)y * rowBytes);
                unsigned char* dst = &out->px[(size_t)y * w * 4];
                for (A_long x = 0; x < w; ++x) {
                    dst[x * 4 + 0] = src[x].blue;
                    dst[x * 4 + 1] = src[x].green;
                    dst[x * 4 + 2] = src[x].red;
                    dst[x * 4 + 3] = src[x].alpha;
                }
            }
            ok = out->valid();
        }
    }
    // 世界为只读（插件不持有）：CheckinFrame 释放；成败都须归还，防渲染缓存泄漏
    rs->AEGP_CheckinFrame(rcpt);
    if (!ok) { if (err) *err = Tr(S_HOTBOX_CAPTURE_ERR_READ_FRAME_PIXELS); return false; }
    return true;
}

// 内存 PNG 编码（剪切板用）：实现在下方 WIC 编码段
static bool encodePngToMemory(const Frame& f, std::vector<unsigned char>* out,
                              std::string* errOut);

// —— 剪切板：注册格式 "PNG"（32bpp 带 alpha）+ CF_DIB 回退 ——
// 为什么给 PNG 而不是只给 CF_DIB：BI_RGB 32bpp 的第 4 字节按约定是"未使用"，绝大多数
// 消费者（GDI / 系统绘图 / 老工具）直接丢掉它 —— 透明通道只有走 PNG 格式才能送达
// （Chromium / Photoshop / Office / 资源管理器认这个格式，按惯例注册名就叫 "PNG"）。
// 回退 DIB 的 alpha 字节统一写 255：给不认识 PNG 格式的应用一张不透明图，不至于把
// 半透明数据当"全透明"糊掉。
bool copyToClipboard(const Frame& f, std::string* msgOut, std::string* errOut) {
    if (!f.valid()) { if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_NO_VALID_PIXELS); return false; }
    std::vector<unsigned char> png;
    if (!encodePngToMemory(f, &png, errOut)) return false;
    UINT pngFmt = RegisterClipboardFormatW(L"PNG");
    if (!pngFmt) { if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_REGISTER_PNG_CLIPBOARD); return false; }

    const size_t imgSz = (size_t)f.w * f.h * 4;
    HGLOBAL hPng = GlobalAlloc(GMEM_MOVEABLE, png.size());
    HGLOBAL hDib = GlobalAlloc(GMEM_MOVEABLE, sizeof(BITMAPINFOHEADER) + imgSz);
    if (!hPng || !hDib) {
        if (hPng) GlobalFree(hPng);
        if (hDib) GlobalFree(hDib);
        if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_MEMORY_ALLOC);
        return false;
    }
    bool filled = false;
    do {
        void* pPng = GlobalLock(hPng);
        void* pDib = GlobalLock(hDib);
        if (!pPng || !pDib) {
            if (pPng) GlobalUnlock(hPng);
            if (pDib) GlobalUnlock(hDib);
            break;
        }
        memcpy(pPng, png.data(), png.size());
        BITMAPINFOHEADER bi = {};
        bi.biSize = sizeof(BITMAPINFOHEADER);
        bi.biWidth = f.w;
        bi.biHeight = f.h;        // 正值 = 自下而上（兼容性最广）
        bi.biPlanes = 1;
        bi.biBitCount = 32;
        bi.biCompression = BI_RGB;
        bi.biSizeImage = (DWORD)imgSz;
        memcpy(pDib, &bi, sizeof(bi));
        unsigned char* dst = (unsigned char*)pDib + sizeof(bi);
        for (int y = 0; y < f.h; ++y) {   // 顶朝下 → 自下而上翻转
            const unsigned char* src = &f.px[(size_t)y * f.w * 4];
            unsigned char* row = dst + (size_t)(f.h - 1 - y) * f.w * 4;
            for (int x = 0; x < f.w; ++x) {
                row[x * 4 + 0] = src[x * 4 + 0];
                row[x * 4 + 1] = src[x * 4 + 1];
                row[x * 4 + 2] = src[x * 4 + 2];
                row[x * 4 + 3] = 255;   // 回退路径不透明，透明数据只由 PNG 格式承载
            }
        }
        GlobalUnlock(hPng);
        GlobalUnlock(hDib);
        filled = true;
    } while (false);
    if (!filled) {
        GlobalFree(hPng);
        GlobalFree(hDib);
        if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_MEMORY_LOCK);
        return false;
    }

    // OpenClipboard 因其他进程短暂占用而失败是常态（一次失败
    // 即报「打开剪切板失败」，无关进程的瞬时占用会直接掐掉用户复制）。重试
    // 5 次、30ms 间隔后再报错；Sleep 只在失败路径付出（最长 ~120ms，主线程可接受）。
    bool clipOpened = false;
    for (int attempt = 0; attempt < 5 && !clipOpened; ++attempt) {
        if (attempt) Sleep(30);
        clipOpened = OpenClipboard(nullptr) != FALSE;
    }
    if (!clipOpened) {
        GlobalFree(hPng);
        GlobalFree(hDib);
        if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_OPEN_CLIPBOARD);
        return false;
    }
    EmptyClipboard();
    // SetClipboardData 失败须自行释放；成功后所有权归剪切板，不可再动
    bool okPng = SetClipboardData(pngFmt, hPng) != nullptr;
    if (okPng) hPng = nullptr;
    bool okDib = SetClipboardData(CF_DIB, hDib) != nullptr;
    if (okDib) hDib = nullptr;
    CloseClipboard();
    if (hPng) GlobalFree(hPng);
    if (hDib) GlobalFree(hDib);
    if (!okPng) {
        if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_WRITE_CLIPBOARD);
        return false;
    }
    if (msgOut) {
        char copyMsg[128];
        snprintf(copyMsg, sizeof(copyMsg), Tr(S_HOTBOX_CAPTURE_MSG_CLIPBOARD_COPIED),
                 f.w, f.h);
        *msgOut = copyMsg;
        if (!okDib) *msgOut += Tr(S_HOTBOX_CAPTURE_MSG_CLIPBOARD_DIB_FALLBACK);
    }
    return true;
}

// —— WIC 编码共用（PNG=32bppBGRA 带 alpha；JPEG=24bppBGR+质量 0.92）——
static IWICImagingFactory* wicFactory(std::string* errOut) {
    IWICImagingFactory* fct = nullptr;
    HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                  IID_PPV_ARGS(&fct));
    if (FAILED(hr) || !fct) { if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_WIC_FACTORY); return nullptr; }
    return fct;
}

// 编码到已就绪的 WIC 流（流的创建归调用方：文件路径 or 内存）。成功即已 Commit。
static bool wicEncodeToStream(IWICImagingFactory* fct, IWICStream* stream, const Frame& f,
                              bool jpeg, std::string* errOut) {
    if (!f.valid()) { if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_NO_VALID_PIXELS); return false; }
    IWICBitmapEncoder* enc = nullptr;
    IWICBitmapFrameEncode* frame = nullptr;
    IPropertyBag2* props = nullptr;
    bool ok = false;
    do {
        HRESULT hr = fct->CreateEncoder(jpeg ? GUID_ContainerFormatJpeg
                                             : GUID_ContainerFormatPng,
                                        nullptr, &enc);
        if (FAILED(hr) || !enc) { if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_CREATE_ENCODER); break; }
        hr = enc->Initialize(stream, WICBitmapEncoderNoCache);
        if (FAILED(hr)) { if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_INIT_ENCODER); break; }
        hr = enc->CreateNewFrame(&frame, &props);
        if (FAILED(hr) || !frame) { if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_CREATE_ENCODER_FRAME); break; }
        if (jpeg) {
            // JPEG 质量 0.92（属性须在 frame->Initialize 前写入）
            PROPBAG2 opt = {};
            VARIANT v;
            VariantInit(&v);
            v.vt = VT_R4;
            v.fltVal = 0.92f;
            opt.pstrName = (LPOLESTR)L"ImageQuality";
            props->Write(1, &opt, &v);
            VariantClear(&v);
        }
        hr = frame->Initialize(props);
        if (FAILED(hr)) { if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_INIT_ENCODER_FRAME); break; }
        hr = frame->SetSize(f.w, f.h);
        if (FAILED(hr)) { if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_SET_FRAME_SIZE); break; }
        if (jpeg) {
            // JPEG 编码器不支持 32 位带 alpha：转 24bppBGR
            WICPixelFormatGUID fmt = GUID_WICPixelFormat24bppBGR;
            hr = frame->SetPixelFormat(&fmt);
            if (FAILED(hr)) { if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_PIXEL_FORMAT_24BPP); break; }
            std::vector<unsigned char> bgr((size_t)f.w * f.h * 3);
            for (int y = 0; y < f.h; ++y) {
                const unsigned char* srow = &f.px[(size_t)y * f.w * 4];
                unsigned char* drow = &bgr[(size_t)y * f.w * 3];
                for (int x = 0; x < f.w; ++x) {
                    drow[x * 3 + 0] = srow[x * 4 + 0];
                    drow[x * 3 + 1] = srow[x * 4 + 1];
                    drow[x * 3 + 2] = srow[x * 4 + 2];
                }
            }
            hr = frame->WritePixels(f.h, f.w * 3, (UINT)bgr.size(), bgr.data());
        } else {
            WICPixelFormatGUID fmt = GUID_WICPixelFormat32bppBGRA;
            hr = frame->SetPixelFormat(&fmt);
            if (FAILED(hr)) { if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_PIXEL_FORMAT_32BPP); break; }
            // WritePixels 签名非 const（实际只读）：const_cast 转裸指针
            hr = frame->WritePixels(f.h, f.w * 4, (UINT)f.px.size(),
                                    const_cast<BYTE*>(f.px.data()));
        }
        if (FAILED(hr)) { if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_WRITE_PIXELS); break; }
        hr = frame->Commit();
        if (FAILED(hr)) { if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_COMMIT_ENCODER_FRAME); break; }
        hr = enc->Commit();
        if (FAILED(hr)) { if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_COMMIT_FILE); break; }
        ok = true;
    } while (false);
    if (frame) frame->Release();
    if (props) props->Release();
    if (enc) enc->Release();
    return ok;
}

// 文件编码（保存对话框已保证目录存在）
static bool wicEncode(const Frame& f, bool jpeg, const std::wstring& wpath,
                      std::string* errOut) {
    IWICImagingFactory* fct = wicFactory(errOut);
    if (!fct) return false;
    IWICStream* stream = nullptr;
    bool ok = false;
    HRESULT hr = fct->CreateStream(&stream);
    if (FAILED(hr) || !stream) {
        if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_CREATE_OUTPUT_STREAM);
    } else if (FAILED(hr = stream->InitializeFromFilename(wpath.c_str(), GENERIC_WRITE))) {
        if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_OPEN_TARGET_FILE);
    } else {
        ok = wicEncodeToStream(fct, stream, f, jpeg, errOut);
    }
    if (stream) stream->Release();
    fct->Release();
    return ok;
}

// 内存 PNG 编码（剪切板用）：WIC → HGLOBAL 流 → 取回字节
static bool encodePngToMemory(const Frame& f, std::vector<unsigned char>* out,
                              std::string* errOut) {
    out->clear();
    IWICImagingFactory* fct = wicFactory(errOut);
    if (!fct) return false;
    IStream* mem = nullptr;
    IWICStream* stream = nullptr;
    bool ok = false;
    HRESULT hr = CreateStreamOnHGlobal(nullptr, TRUE, &mem);
    if (FAILED(hr) || !mem) {
        if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_CREATE_MEMORY_STREAM);
    } else if (FAILED(hr = fct->CreateStream(&stream)) || !stream ||
               FAILED(hr = stream->InitializeFromIStream(mem))) {
        if (errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_CREATE_OUTPUT_STREAM);
    } else if (wicEncodeToStream(fct, stream, f, false, errOut)) {
        // 编码器已 Commit：字节数取流 Stat —— HGLOBAL 的 GlobalSize 含分配粒度，会偏大
        HGLOBAL hg = nullptr;
        STATSTG st = {};
        const void* p = nullptr;
        if (SUCCEEDED(GetHGlobalFromStream(mem, &hg)) && hg &&
            SUCCEEDED(mem->Stat(&st, STATFLAG_NONAME)) && st.cbSize.QuadPart > 0 &&
            (p = GlobalLock(hg)) != nullptr) {
            const unsigned char* b = (const unsigned char*)p;
            out->assign(b, b + (size_t)st.cbSize.QuadPart);
            GlobalUnlock(hg);
            ok = !out->empty();
        }
        if (!ok && errOut) *errOut = Tr(S_HOTBOX_CAPTURE_ERR_READ_PNG_BYTES);
    }
    if (stream) stream->Release();
    if (mem) mem->Release();
    fct->Release();
    return ok;
}

// 文件名净化：合成名去非法字符、限长；拼接本地时间戳防重名
static std::wstring defaultFileStem(const std::string& compNameUtf8) {
    std::wstring s = data::utf8ToWide(compNameUtf8);
    for (wchar_t& c : s) {
        if (c == L'\\' || c == L'/' || c == L':' || c == L'*' || c == L'?' ||
            c == L'"' || c == L'<' || c == L'>' || c == L'|')
            c = L'_';
    }
    if (s.size() > 40) s.resize(40);
    if (s.empty()) s = L"comp";
    SYSTEMTIME st;
    GetLocalTime(&st);
    wchar_t ts[32];
    swprintf_s(ts, L"_%04d%02d%02d_%02d%02d%02d",
               st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    return s + ts;
}

// 保存对话框 + WIC 编码（默认目录=系统图片库；取消对话框=非错误）
static bool saveImage(const Frame& f, HWND owner, bool jpeg,
                      std::string* msgOut, std::string* errOut) {
    const wchar_t* ext = jpeg ? L"jpg" : L"png";
    std::wstring file = defaultFileStem(f.compNameUtf8) + L"." + ext;
    wchar_t buf[MAX_PATH];
    wcsncpy_s(buf, file.c_str(), _TRUNCATE);
    // 默认目录：系统图片库
    std::wstring initialDir;
    PWSTR pics = nullptr;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Pictures, 0, nullptr, &pics))) {
        initialDir = pics;
        CoTaskMemFree(pics);
    }
    OPENFILENAMEW ofn = {};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = owner;
    // 过滤器按当前语言本地化：结构保持 <说明>\0<通配符>\0...\0，双 NUL 结尾由 c_str() 补齐
    std::wstring filter = jpeg ? TrW(S_HOTBOX_CAPTURE_DLG_JPEG_FILTER)
                               : TrW(S_HOTBOX_CAPTURE_DLG_PNG_FILTER);
    filter += L'\0';
    filter += jpeg ? L"*.jpg" : L"*.png";
    filter += L'\0';
    filter += TrW(S_HOTBOX_CAPTURE_DLG_ALL_FILES);
    filter += L'\0';
    filter += L"*.*";
    filter += L'\0';
    ofn.lpstrFilter = filter.c_str();
    ofn.lpstrFile = buf;
    ofn.nMaxFile = MAX_PATH;
    if (!initialDir.empty()) ofn.lpstrInitialDir = initialDir.c_str();
    // NOCHANGEDIR：防对话框改进程 CWD（影响脚本/数据目录的相对路径语义）
    ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    if (!GetSaveFileNameW(&ofn)) {
        if (msgOut) *msgOut = Tr(S_HOTBOX_CAPTURE_MSG_SAVE_CANCELED);
        return true;   // 取消不是错误
    }
    std::wstring path(buf);
    // 用户可能删掉扩展名：无则补回，保证双击关联
    std::wstring lower = path;
    for (auto& c : lower) c = (wchar_t)towlower(c);
    if (lower.size() < 4 || lower.substr(lower.size() - 4) != (std::wstring(L".") + ext)) {
        std::wstring::size_type slash = path.find_last_of(L"\\/");
        std::wstring::size_type dot = path.find_last_of(L'.');
        if (dot == std::wstring::npos || (slash != std::wstring::npos && dot < slash))
            path += L"." + (std::wstring)ext;
        else
            path = path.substr(0, dot) + L"." + ext;   // 替换错误扩展
    }
    if (!wicEncode(f, jpeg, path, errOut)) return false;
    if (msgOut) {
        char saveMsg[1024];
        snprintf(saveMsg, sizeof(saveMsg), Tr(S_HOTBOX_CAPTURE_MSG_SAVED),
                 data::wideToUtf8(path).c_str());
        *msgOut = saveMsg;
    }
    return true;
}

bool saveAsPng(const Frame& f, HWND owner, std::string* msgOut, std::string* errOut) {
    return saveImage(f, owner, false, msgOut, errOut);
}

bool saveAsJpg(const Frame& f, HWND owner, std::string* msgOut, std::string* errOut) {
    return saveImage(f, owner, true, msgOut, errOut);
}

} // namespace capture
