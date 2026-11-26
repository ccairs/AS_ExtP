;(function (__aeSG) {
// ── 稳定键寻址（id）───────────────────────────────────────────────
// layer.id / Item.id 在工程内唯一且持久（官方口径：保存到文件再加载，ID 不变）；
// layer.index 是层叠位置、合成/图层名字可改——「面板读到引用」与「工具执行」之间隔着
// 用户操作（增删层、重排、改名），位置键/名字会指向别的对象。故给了 id 就以 id 为准，
// 解析不到**抛错**（fail-closed），不静默退回位置键——那会打到别的层/合成。
// 旧版 AE 无 layerByID/itemByID 时退回遍历比对 .id；连 .id 都没有（id 读成 0）则
// id 路径不可用，同样落到"找不到"报错。
function _readItemId(item) {
    if (!item) return 0;
    try { var id = Math.floor(Number(item.id)); return id > 0 ? id : 0; } catch (_) { return 0; }
}

function _readLayerId(layer) {
    if (!layer) return 0;
    try { var id = Math.floor(Number(layer.id)); return id > 0 ? id : 0; } catch (_) { return 0; }
}

function _findItemById(itemId) {
    var id = Math.floor(Number(itemId));
    if (!(id > 0)) return null;
    try {
        if (typeof app.project.itemByID === "function") {
            var byId = app.project.itemByID(id);
            if (byId) return byId;
        }
    } catch (_) { /* 无效 id 会抛异常，落到下面的遍历 */ }
    var total = 0;
    try { total = app.project.numItems; } catch (_) { total = 0; }
    for (var i = 1; i <= total; i++) {
        var cand = app.project.item(i);
        if (_readItemId(cand) === id) return cand;
    }
    return null;
}

// 按 id 定位图层并复核所属合成：id 命中但属于别的合成 = 不算命中（否则会操作到
// 同工程其它合成里的层）。合成 id 读不到时退回对象同一性比较。
function _findLayerById(comp, layerId) {
    var id = Math.floor(Number(layerId));
    if (!(id > 0) || !comp) return null;
    var layer = null;
    try {
        if (typeof app.project.layerByID === "function") layer = app.project.layerByID(id);
    } catch (_) { layer = null; }
    if (!layer) {
        var n = 0;
        try { n = comp.numLayers; } catch (_) { n = 0; }
        for (var i = 1; i <= n; i++) {
            var cand = comp.layer(i);
            if (_readLayerId(cand) === id) { layer = cand; break; }
        }
    }
    if (!layer) return null;
    var wantCompId = _readItemId(comp);
    var gotCompId = 0;
    try { gotCompId = _readItemId(layer.containingComp); } catch (_) { gotCompId = 0; }
    if (wantCompId > 0 && gotCompId > 0) return wantCompId === gotCompId ? layer : null;
    try { return layer.containingComp === comp ? layer : null; } catch (_) { return null; }
}

// opts.detectSameName（仅预览抓帧传）——compName 命中多个同名合成时抛错并带
// matchedCompositionIds/compName，不静默取首个（抓帧会把另一个同名合成的帧当目标交给视觉
// 上下文）。其它调用方不传该参数，行为不变（首个命中）；同时只遍历一次，不增加宿主扫描。
function getActiveComp(args, opts) {
    var _detectSameName = !!(opts && opts.detectSameName === true);
    // 稳定键优先：compositionId（Item.id）。给了 id 却解析不到 → 抛错，不退回按索引/按名，
    // 否则会操作到别的合成（索引随项目面板增删移位、合成可重名）。
    var wantCompositionId = (args && args.compositionId !== undefined && args.compositionId !== null)
        ? Math.floor(Number(args.compositionId)) : 0;
    if (wantCompositionId > 0) {
        var byIdComp = _findItemById(wantCompositionId);
        if (byIdComp instanceof CompItem) return byIdComp;
        throw new Error("Composition id not found (deleted?): " + wantCompositionId);
    }
    // compositionIndex 是工具面对外的参数名、compIndex 是内部别名：两个都收（只认
    // compIndex，调用方从工具文档抄 compositionIndex 时会被静默忽略、落到活动合成）。
    var compName = args && args.compName ? args.compName : "";
    if (compName) {
        var nameMatches = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.name === compName) {
                if (!_detectSameName) return item;
                nameMatches.push(item);
            }
        }
        if (_detectSameName && nameMatches.length > 1) {
            var matchedIds = [];
            for (var mi = 0; mi < nameMatches.length; mi++) matchedIds.push(_readItemId(nameMatches[mi]));
            var ambErr = new Error("同名合成歧义：工程中有 " + nameMatches.length + " 个名为 \"" + compName
                + "\" 的合成（compositionId: " + matchedIds.join(", ") + "）。请改用 compositionId 指定目标合成。");
            ambErr.compName = String(compName);
            ambErr.matchedCompositionIds = matchedIds;
            throw ambErr;
        }
        return nameMatches.length === 1 ? nameMatches[0] : null;
    }
    // null = 未传（统一语义）：compIndex 显式给 null 时不得吞掉同给的 compositionIndex
    var wantCompIndex = (args && args.compIndex !== undefined && args.compIndex !== null) ? args.compIndex
        : (args ? args.compositionIndex : undefined);
    if (wantCompIndex !== undefined && wantCompIndex !== null && Number(wantCompIndex) > 0) {
        var idx = Math.floor(Number(wantCompIndex));
        if (idx >= 1 && idx <= app.project.numItems) {
            var item = app.project.item(idx);
            if (item instanceof CompItem) return item;
        }
        return null;
    }
    if (app.project.activeItem instanceof CompItem) return app.project.activeItem;
    return null;
}

function getCompOrThrow(args) {
    var comp = getActiveComp(args);
    if (!comp) {
        var name = args && args.compName ? args.compName : "";
        throw new Error("No composition found" + (name ? " with name '" + name + "'" : " and no active composition"));
    }
    return comp;
}

// ADBE match-name map — these internal names work in ALL AE language versions
// (English "Position", Chinese "位置", etc. all resolve to the same match name)
var ADBE_MATCH = {
"3D Camera Tracker": "ADBE 3D Tracker",
    "3D Channel Extract": "ADBE AUX CHANNEL EXTRACT",
    "3D Glasses": "ADBE 3D Glasses2",
    "3D Glasses (Legacy)": "ADBE 3D Glasses",
    "3DText Back Ambient": "ADBE 3DText Back Ambient",
    "3DText Back Bright": "ADBE 3DText Back Bright",
    "3DText Back Diffuse": "ADBE 3DText Back Diffuse",
    "3DText Back Fresnel": "ADBE 3DText Back Fresnel",
    "3DText Back Gloss": "ADBE 3DText Back Gloss",
    "3DText Back Hue": "ADBE 3DText Back Hue",
    "3DText Back IOR": "ADBE 3DText Back IOR",
    "3DText Back Metal": "ADBE 3DText Back Metal",
    "3DText Back Opacity": "ADBE 3DText Back Opacity",
    "3DText Back Reflection": "ADBE 3DText Back Reflection",
    "3DText Back RGB": "ADBE 3DText Back RGB",
    "3DText Back Sat": "ADBE 3DText Back Sat",
    "3DText Back Shininess": "ADBE 3DText Back Shininess",
    "3DText Back Specular": "ADBE 3DText Back Specular",
    "3DText Back Xparency": "ADBE 3DText Back Xparency",
    "3DText Back XparRoll": "ADBE 3DText Back XparRoll",
    "3DText Bevel Ambient": "ADBE 3DText Bevel Ambient",
    "3DText Bevel Bright": "ADBE 3DText Bevel Bright",
    "3DText Bevel Depth": "ADBE 3DText Bevel Depth",
    "3DText Bevel Diffuse": "ADBE 3DText Bevel Diffuse",
    "3DText Bevel Fresnel": "ADBE 3DText Bevel Fresnel",
    "3DText Bevel Gloss": "ADBE 3DText Bevel Gloss",
    "3DText Bevel Hue": "ADBE 3DText Bevel Hue",
    "3DText Bevel IOR": "ADBE 3DText Bevel IOR",
    "3DText Bevel Metal": "ADBE 3DText Bevel Metal",
    "3DText Bevel Opacity": "ADBE 3DText Bevel Opacity",
    "3DText Bevel Reflection": "ADBE 3DText Bevel Reflection",
    "3DText Bevel RGB": "ADBE 3DText Bevel RGB",
    "3DText Bevel Sat": "ADBE 3DText Bevel Sat",
    "3DText Bevel Shininess": "ADBE 3DText Bevel Shininess",
    "3DText Bevel Specular": "ADBE 3DText Bevel Specular",
    "3DText Bevel Xparency": "ADBE 3DText Bevel Xparency",
    "3DText Bevel XparRoll": "ADBE 3DText Bevel XparRoll",
    "3DText Extrude Depth": "ADBE 3DText Extrude Depth",
    "3DText Front Ambient": "ADBE 3DText Front Ambient",
    "3DText Front Bright": "ADBE 3DText Front Bright",
    "3DText Front Diffuse": "ADBE 3DText Front Diffuse",
    "3DText Front Fresnel": "ADBE 3DText Front Fresnel",
    "3DText Front Gloss": "ADBE 3DText Front Gloss",
    "3DText Front Hue": "ADBE 3DText Front Hue",
    "3DText Front IOR": "ADBE 3DText Front IOR",
    "3DText Front Metal": "ADBE 3DText Front Metal",
    "3DText Front Opacity": "ADBE 3DText Front Opacity",
    "3DText Front Reflection": "ADBE 3DText Front Reflection",
    "3DText Front RGB": "ADBE 3DText Front RGB",
    "3DText Front Sat": "ADBE 3DText Front Sat",
    "3DText Front Shininess": "ADBE 3DText Front Shininess",
    "3DText Front Specular": "ADBE 3DText Front Specular",
    "3DText Front Xparency": "ADBE 3DText Front Xparency",
    "3DText Front XparRoll": "ADBE 3DText Front XparRoll",
    "3DText Side Ambient": "ADBE 3DText Side Ambient",
    "3DText Side Bright": "ADBE 3DText Side Bright",
    "3DText Side Diffuse": "ADBE 3DText Side Diffuse",
    "3DText Side Fresnel": "ADBE 3DText Side Fresnel",
    "3DText Side Gloss": "ADBE 3DText Side Gloss",
    "3DText Side Hue": "ADBE 3DText Side Hue",
    "3DText Side IOR": "ADBE 3DText Side IOR",
    "3DText Side Metal": "ADBE 3DText Side Metal",
    "3DText Side Opacity": "ADBE 3DText Side Opacity",
    "3DText Side Reflection": "ADBE 3DText Side Reflection",
    "3DText Side RGB": "ADBE 3DText Side RGB",
    "3DText Side Sat": "ADBE 3DText Side Sat",
    "3DText Side Shininess": "ADBE 3DText Side Shininess",
    "3DText Side Specular": "ADBE 3DText Side Specular",
    "3DText Side Xparency": "ADBE 3DText Side Xparency",
    "3DText Side XparRoll": "ADBE 3DText Side XparRoll",
    "4-Color Gradient": "ADBE 4ColorGradient",
    "Accepts Lights": "ADBE Accepts Lights",
    "Accepts Shadows": "ADBE Accepts Shadows",
    "Advanced Blending": "ADBE Adv Blend Group",
    "Advanced Lightning": "ADBE Lightning 2",
    "Advanced Spill Suppressor": "ADBE Spill2",
    "Alpha Levels": "ADBE Alpha Levels3",
    "Ambient": "ADBE Ambient Coefficient",
    "Ambient Coefficient": "ADBE Ambient Coefficient",
    "Anchor Point": "ADBE Anchor Point",
    "Angle Control": "ADBE Angle Control",
    "Animator": "ADBE Text Animator",
    "Animator Properties": "ADBE Text Animator Properties",
    "Animators": "ADBE Text Animators",
    "Aperture": "ADBE Camera Aperture",
    "Apply Color LUT": "ADBE Apply Color LUT2",
    "Apply Color LUT (Legacy)": "ADBE Apply Color LUT",
    "Arithmetic": "ADBE Arithmetic",
    "Audio": "ADBE Audio Group",
    "Audio Levels": "ADBE Audio Levels",
    "Audio Spectrum": "ADBE AudSpect",
    "Audio Waveform": "ADBE AudWave",
    "Auto Color": "ADBE AutoColor",
    "Auto Contrast": "ADBE AutoContrast",
    "Auto Levels": "ADBE AutoLevels",
    "AV Layer": "ADBE AV Layer",
    "B Channel Blend": "ADBE B Channel Blend",
    "Basic 3D": "ADBE Basic 3D",
    "Basic Text": "ADBE Basic Text2",
    "Bass & Treble": "ADBE Aud BT",
    "Beam": "ADBE Laser",
    "Bevel Alpha": "ADBE Bevel Alpha",
    "Bevel Depth": "ADBE Bevel Depth",
    "Bevel Edges": "ADBE Bevel Edges",
    "Bezier Warp": "ADBE BEZMESH",
    "Bilateral Blur": "ADBE Bilateral",
    "Black & White": "ADBE Black&White",
    "Blend": "ADBE Blend",
    "Blend Interior": "ADBE Blend Interior",
    "Blend Options": "ADBE Blend Options Group",
    "Blend Ranges": "ADBE Blend Ranges",
    "Block Dissolve": "ADBE Block Dissolve",
    "Blur Level": "ADBE Camera Blur Level",
    "Box Blur": "ADBE Box Blur2",
    "Box Blur (Legacy)": "ADBE Box Blur",
    "Brightness & Contrast": "ADBE Brightness & Contrast 2",
    "Brightness & Contrast (Legacy)": "ADBE Brightness & Contrast",
    "Broadcast Colors": "ADBE Broadcast Colors",
    "Brush Strokes": "ADBE Brush Strokes",
    "Bulge": "ADBE Bulge",
    "Calculations": "ADBE Calculations",
    "Camera Layer": "ADBE Camera Layer",
    "Camera Lens Blur": "ADBE Camera Lens Blur",
    "Camera Options": "ADBE Camera Options Group",
    "Camera-Shake Deblur": "ADBE CameraShakeDeblur",
    "Cartoon": "ADBE Cartoonify",
    "Casts Shadows": "ADBE Casts Shadows",
    "Cell Pattern": "ADBE Cell Pattern",
    "Change Color": "ADBE Change Color",
    "Change to Color": "ADBE Change To Color",
    "Channel Blur": "ADBE Channel Blur",
    "Channel Combiner": "ADBE Channel Combiner",
    "Channel Mixer": "ADBE CHANNEL MIXER",
    "Checkbox Control": "ADBE Checkbox Control",
    "Checkerboard": "ADBE Checkerboard",
    "Cineon Converter": "ADBE Cineon Converter2",
    "Cineon Converter (Legacy)": "ADBE Cineon Converter",
    "Circle": "ADBE Circle",
    "Color Balance": "ADBE Color Balance 2",
    "Color Balance (HLS)": "ADBE Color Balance (HLS)",
    "Color Balance (Legacy)": "ADBE Color Balance",
    "Color Control": "ADBE Color Control",
    "Color Difference Key": "ADBE Color Difference Key",
    "Color Emboss": "ADBE Color Emboss",
    "Color Key": "ADBE Color Key",
    "Color Link": "ADBE Color Link",
    "Color Profile Converter": "ADBE ProfileToProfile",
    "Color Range": "ADBE Color Range",
    "Color Stabilizer": "ADBE Deflicker",
    "Compound Arithmetic": "ADBE Compound Arithmetic",
    "Compound Blur": "ADBE Compound Blur",
    "Cone Angle": "ADBE Light Cone Angle",
    "Cone Feather": "ADBE Light Cone Feather 2",
    "Contents": "ADBE Root Vectors Group",
    "Corner Pin": "ADBE Corner Pin",
    "Curvature": "ADBE Plane Curvature",
    "Curves": "ADBE CurvesCustom",
    "Delay": "ADBE Aud Delay",
    "Depth Matte": "ADBE DEPTH MATTE",
    "Depth of Field": "ADBE DEPTH FIELD",
    "Detail-preserving Upscale": "ADBE Upscale",
    "Difference Matte": "ADBE Difference Matte2",
    "Diffuse": "ADBE Diffuse Coefficient",
    "Diffuse Coefficient": "ADBE Diffuse Coefficient",
    "Direction": "ADBE Vector Shape Direction",
    "Directional Blur": "ADBE Motion Blur",
    "Displacement Map": "ADBE Displacement Map",
    "Drop Shadow": "ADBE Drop Shadow",
    "Dropdown Menu Control": "ADBE Dropdown Control",
    "Dust & Scratches": "ADBE Dust & Scratches",
    "Echo": "ADBE Echo",
    "Effects": "ADBE Effect Parade",
    "Ellipse": "ADBE Vector Shape - Ellipse",
    "Emboss": "ADBE Emboss",
    "Equalize": "ADBE Equalize",
    "Essential Properties": "ADBE Layer Overrides",
    "Exposure": "ADBE Exposure2",
    "Exposure (Legacy)": "ADBE Exposure",
    "Extract": "ADBE Extract",
    "Extrusion Depth": "ADBE Extrsn Depth",
    "Eyedropper Fill": "ADBE Eyedropper Fill",
    "Falloff Distance": "ADBE Light Falloff Distance",
    "Falloff Start": "ADBE Light Falloff Start",
    "Falloff Type": "ADBE Light Falloff Type",
    "Fast Blur (Legacy)": "ADBE Fast Blur",
    "Fill": "ADBE Vector Graphic - Fill",
    "Fill Opacity": "ADBE Layer Fill Opacity2",
    "Find Edges": "ADBE Find Edges",
    "Flange & Chorus": "ADBE Aud_Flange",
    "Focus Distance": "ADBE Camera Focus Distance",
    "Fog 3D": "ADBE FOG_3D",
    "Fractal": "ADBE Fractal",
    "Fractal Noise": "ADBE Fractal Noise",
    "Fresnel Coefficient": "ADBE Fresnel Coefficient",
    "G Channel Blend": "ADBE G Channel Blend",
    "Gamma/Pedestal/Gain": "ADBE Gamma/Pedestal/Gain2",
    "Gaussian Blur": "ADBE Gaussian Blur 2",
    "Gaussian Blur (Legacy)": "ADBE Gaussian Blur",
    "Geometry Options": "ADBE Plane Options Group",
    "Global Light Altitude": "ADBE Global Altitude2",
    "Global Light Angle": "ADBE Global Angle2",
    "Glossiness Coefficient": "ADBE Glossiness Coefficient",
    "Glow": "ADBE Glo2",
    "Gradient Fill": "ADBE Vector Graphic - G-Fill",
    "Gradient Ramp": "ADBE Ramp",
    "Gradient Stroke": "ADBE Vector Graphic - G-Stroke",
    "Gradient Wipe": "ADBE Gradient Wipe",
    "Grid": "ADBE Grid",
    "Group": "ADBE Vector Group",
    "Grow Bounds": "ADBE GROW BOUNDS",
    "HDR Compander": "ADBE Compander",
    "HDR Highlight Compression": "ADBE HDR ToneMap",
    "High-Low Pass": "ADBE Aud HiLo",
    "Hole Bevel Depth": "ADBE Hole Bevel Depth",
    "Hue/Saturation": "ADBE HUE SATURATION",
    "ID Matte": "ADBE ID MATTE",
    "Index of Refraction": "ADBE Index of Refraction",
    "Inner/Outer Key": "ADBE ATG Extract",
    "Intensity": "ADBE Light Intensity",
    "Invert": "ADBE Invert",
    "Iris Aspect Ratio": "ADBE Iris Aspect Ratio",
    "Iris Diffraction Fringe": "ADBE Iris Diffraction Fringe",
    "Iris Highlight Gain": "ADBE Iris Highlight Gain",
    "Iris Highlight Threshold": "ADBE Iris Highlight Threshold",
    "Iris Hightlight Saturation": "ADBE Iris Hightlight Saturation",
    "Iris Rotation": "ADBE Iris Rotation",
    "Iris Roundness": "ADBE Iris Roundness",
    "Iris Shape": "ADBE Iris Shape",
    "Iris Wipe": "ADBE IRIS_WIPE",
    "Key Cleaner": "ADBE KeyCleaner",
    "Layer Control": "ADBE Layer Control",
    "Layer Source Alternate": "ADBE Layer Source Alternate",
    "Leave Color": "ADBE Leave Color",
    "Lens Flare": "ADBE Lens Flare",
    "Levels": "ADBE Easy Levels2",
    "Levels (Individual Controls, Legacy)": "ADBE Pro Levels",
    "Levels (Individual Controls)": "ADBE Pro Levels2",
    "Levels (Legacy)": "ADBE Easy Levels",
    "Light Color": "ADBE Light Color",
    "Light Layer": "ADBE Light Layer",
    "Light Options": "ADBE Light Options Group",
    "Light Transmission": "ADBE Light Transmission",
    "Lightning (Legacy)": "ADBE Lightning",
    "Linear Color Key": "ADBE Linear Color Key2",
    "Linear Wipe": "ADBE Linear Wipe",
    "Liquify": "ADBE LIQUIFY",
    "Luma Key": "ADBE Luma Key",
    "Lumetri Color": "ADBE Lumetri",
    "Magnify": "ADBE Magnify",
    "Marker": "ADBE Marker",
    "Mask Expansion": "ADBE Mask Expansion",
    "Mask Feather": "ADBE Mask Feather",
    "Mask Mode": "ADBE Mask Mode",
    "Mask Opacity": "ADBE Mask Opacity",
    "Mask Path": "ADBE Mask Shape",
    "Masks": "ADBE Mask Parade",
    "Material Options": "ADBE Material Options Group",
    "Matte Choker": "ADBE Matte Choker",
    "Median": "ADBE Median",
    "Merge Paths": "ADBE Vector Filter - Merge",
    "Mesh Warp": "ADBE MESH WARP",
    "Metal": "ADBE Metal Coefficient",
    "Metal Coefficient": "ADBE Metal Coefficient",
    "Minimax": "ADBE Minimax",
    "Mirror": "ADBE Mirror",
    "Modulator": "ADBE Aud Modulator",
    "Mosaic": "ADBE Mosaic",
    "Motion Tile": "ADBE Tile",
    "Motion Trackers": "ADBE MTrackers",
    "Noise": "ADBE Noise",
    "Noise Alpha": "ADBE Noise Alpha2",
    "Noise Alpha (Legacy)": "ADBE Noise Alpha",
    "Noise HLS": "ADBE Noise HLS2",
    "Noise HLS (Legacy)": "ADBE Noise HLS",
    "Noise HLS Auto": "ADBE Noise HLS Auto2",
    "Noise HLS Auto (Legacy)": "ADBE Noise HLS Auto",
    "Numbers": "ADBE Numbers2",
    "Offset": "ADBE Offset",
    "Offset Paths": "ADBE Vector Filter - Offset",
    "Opacity": "ADBE Opacity",
    "Optics Compensation": "ADBE Optics Compensation",
    "Orientation": "ADBE Orientation",
    "Paint": "ADBE Paint",
    "Paint Bucket": "ADBE Paint Bucket",
    "Parametric EQ": "ADBE Param EQ",
    "Particle Playground": "ADBE Playgnd",
    "Path": "ADBE Vector Shape - Group",
    "Path Text": "ADBE Path Text",
    "Photo Filter": "ADBE PhotoFilterPS",
    "Photo Filter (Legacy)": "ADBE Photo Filter",
    "Pixel Motion Blur": "ADBE OFMotionBlur",
    "Point Control": "ADBE Point Control",
    "Point of Interest": "ADBE Point of Interest",
    "Point3D Control": "ADBE Point3D Control",
    "Polar Coordinates": "ADBE Polar Coordinates",
    "Polystar": "ADBE Vector Shape - Star",
    "Position": "ADBE Position",
    "Position_": "ADBE Position_2",
    "Posterize": "ADBE Posterize",
    "Posterize Time": "ADBE Posterize Time",
    "PS Arbitrary Map": "ADBE PS Arbitrary Map",
    "PSL Bevel Emboss": "ADBE PSL Bevel Emboss",
    "PSL Drop Shadow": "ADBE PSL Drop Shadow",
    "PSL Inner Glow": "ADBE PSL Inner Glow",
    "PSL Inner Shadow": "ADBE PSL Inner Shadow",
    "PSL Outer Glow": "ADBE PSL Outer Glow",
    "PSL Solid Fill": "ADBE PSL Solid Fill",
    "Pucker & Bloat": "ADBE Vector Filter - PB",
    "Puppet": "ADBE FreePin3",
    "R Channel Blend": "ADBE R Channel Blend",
    "Radial Blur": "ADBE Radial Blur",
    "Radial Shadow": "ADBE Radial Shadow",
    "Radial Wipe": "ADBE Radial Wipe",
    "Range Selector": "ADBE Text Selector",
    "Rectangle": "ADBE Vector Shape - Rect",
    "Reduce Interlace Flicker": "ADBE Reduce Interlace Flicker",
    "Refine Hard Matte": "ADBE RefineRBMatte",
    "Refine Matte (Legacy)": "ADBE RefineMatte",
    "Refine Soft Matte": "ADBE RefineMatte2",
    "Reflection Coefficient": "ADBE Reflection Coefficient",
    "Remove Color Matting": "ADBE Remove Color Matting",
    "Repeater": "ADBE Vector Filter - Repeater",
    "Repeater Transform": "ADBE Vector Repeater Transform",
    "Reshape": "ADBE RESHAPE",
    "Reverb": "ADBE Aud Reverb",
    "Reverse": "ADBE Aud Reverse",
    "Ripple": "ADBE Ripple",
    "Rolling Shutter Repair": "ADBE Rolling Shutter",
    "Rotate X": "ADBE Rotate X",
    "Rotate Y": "ADBE Rotate Y",
    "Rotate Z": "ADBE Rotate Z",
    "Rotation": "ADBE Rotate Z",
    "Roto Brush & Refine Edge": "ADBE Samurai",
    "Roughen Edges": "ADBE Roughen Edges",
    "Round Corners": "ADBE Vector Filter - RC",
    "Scale": "ADBE Scale",
    "Scatter": "ADBE Scatter",
    "Scribble": "ADBE Scribble Fill",
    "Selective Color": "ADBE SelectiveColor",
    "Selectors": "ADBE Text Selectors",
    "Set Channels": "ADBE Set Channels",
    "Set Matte": "ADBE Set Matte3",
    "Set Matte (Legacy)": "ADBE Set Matte2",
    "Shadow Darkness": "ADBE Light Shadow Darkness",
    "Shadow Diffusion": "ADBE Light Shadow Diffusion",
    "Shadow/Highlight": "ADBE ShadowHighlight",
    "Shape Transform": "ADBE Vector Transform Group",
    "Sharpen": "ADBE Sharpen",
    "Shift Channels": "ADBE Shift Channels",
    "Shininess Coefficient": "ADBE Shininess Coefficient",
    "Simple Choker": "ADBE Simple Choker",
    "Slider Control": "ADBE Slider Control",
    "Smart Blur": "ADBE Smart Blur",
    "Smear": "ADBE SCHMEAR",
    "Solid Composite": "ADBE Solid Composite",
    "Source Text": "ADBE Text Document",
    "Specular Coefficient": "ADBE Specular Coefficient",
    "Specular Intensity": "ADBE Specular Coefficient",
    "Specular Shininess": "ADBE Shininess Coefficient",
    "Spherize": "ADBE Spherize",
    "Spill Suppressor": "ADBE Spill Suppressor",
    "Stereo Mixer": "ADBE Aud Stereo Mixer",
    "Strobe Light": "ADBE Strobe",
    "Stroke": "ADBE Vector Graphic - Stroke",
    "Stroke Width": "ADBE Vector Stroke Width",
    "Subdivision": "ADBE Plane Subdivision",
    "Text": "ADBE Text Properties",
    "Text Anchor Point 3D": "ADBE Text Anchor Point 3D",
    "Text Anchor Point Align": "ADBE Text Anchor Point Align",
    "Text Blur": "ADBE Text Blur",
    "Text Character Offset": "ADBE Text Character Offset",
    "Text Character Replace": "ADBE Text Character Replace",
    "Text Fill Brightness": "ADBE Text Fill Brightness",
    "Text Fill Color": "ADBE Text Fill Color",
    "Text Fill Hue": "ADBE Text Fill Hue",
    "Text Fill Opacity": "ADBE Text Fill Opacity",
    "Text Fill Saturation": "ADBE Text Fill Saturation",
    "Text First Margin": "ADBE Text First Margin",
    "Text Force Align Path": "ADBE Text Force Align Path",
    "Text Index End": "ADBE Text Index End",
    "Text Index Offset": "ADBE Text Index Offset",
    "Text Index Start": "ADBE Text Index Start",
    "Text Last Margin": "ADBE Text Last Margin",
    "Text Layer": "ADBE Text Layer",
    "Text Levels Max Ease": "ADBE Text Levels Max Ease",
    "Text Levels Min Ease": "ADBE Text Levels Min Ease",
    "Text Line Anchor": "ADBE Text Line Anchor",
    "Text Line Spacing": "ADBE Text Line Spacing",
    "Text More Options": "ADBE Text More Options",
    "Text Opacity": "ADBE Text Opacity",
    "Text Path Options": "ADBE Text Path Options",
    "Text Percent End": "ADBE Text Percent End",
    "Text Percent Offset": "ADBE Text Percent Offset",
    "Text Percent Start": "ADBE Text Percent Start",
    "Text Perpendicular To Path": "ADBE Text Perpendicular To Path",
    "Text Position 3D": "ADBE Text Position 3D",
    "Text Random Seed": "ADBE Text Random Seed",
    "Text Range Advanced": "ADBE Text Range Advanced",
    "Text Reverse Path": "ADBE Text Reverse Path",
    "Text Rotation X": "ADBE Text Rotation X",
    "Text Rotation Y": "ADBE Text Rotation Y",
    "Text Scale 3D": "ADBE Text Scale 3D",
    "Text Selector Max Amount": "ADBE Text Selector Max Amount",
    "Text Selector Mode": "ADBE Text Selector Mode",
    "Text Selector Smoothness": "ADBE Text Selector Smoothness",
    "Text Skew": "ADBE Text Skew",
    "Text Skew Axis": "ADBE Text Skew Axis",
    "Text Stroke Brightness": "ADBE Text Stroke Brightness",
    "Text Stroke Color": "ADBE Text Stroke Color",
    "Text Stroke Hue": "ADBE Text Stroke Hue",
    "Text Stroke Opacity": "ADBE Text Stroke Opacity",
    "Text Stroke Saturation": "ADBE Text Stroke Saturation",
    "Text Stroke Width": "ADBE Text Stroke Width",
    "Text Track Type": "ADBE Text Track Type",
    "Text Tracking Amount": "ADBE Text Tracking Amount",
    "Texturize": "ADBE Texturize",
    "Three-Way Color Corrector": "ADBE Three-Way Color Corrector",
    "Threshold": "ADBE Threshold2",
    "Threshold (Legacy)": "ADBE Threshold",
    "Time Difference": "ADBE Difference",
    "Time Displacement": "ADBE Time Displacement",
    "Time Remap": "ADBE Time Remapping",
    "Time Remapping": "ADBE Time Remapping",
    "Time Warp": "ADBE Timewarp",
    "Timecode": "ADBE Timecode",
    "Tint": "ADBE Tint",
    "Tone": "ADBE Aud Tone",
    "Transform": "ADBE Transform Group",
    "Transform (Legacy)": "ADBE Geometry",
    "Transparency Coefficient": "ADBE Transparency Coefficient",
    "Transparency Rolloff": "ADBE Transp Rolloff",
    "Trim Paths": "ADBE Vector Filter - Trim",
    "Tritone": "ADBE Tritone",
    "Turbulent Displace": "ADBE Turbulent Displace",
    "Turbulent Noise": "ADBE AIF Perlin Noise 3D",
    "Twirl": "ADBE Twirl",
    "Twist": "ADBE Vector Filter - Twist",
    "Unsharp Mask": "ADBE Unsharp Mask2",
    "Unsharp Mask (Legacy)": "ADBE Unsharp Mask",
    "Vector Blend Mode": "ADBE Vector Blend Mode",
    "Vector Composite Order": "ADBE Vector Composite Order",
    "Vector Correlation": "ADBE Vector Correlation",
    "Vector Ellipse Position": "ADBE Vector Ellipse Position",
    "Vector Ellipse Size": "ADBE Vector Ellipse Size",
    "Vector Fill Color": "ADBE Vector Fill Color",
    "Vector Fill Opacity": "ADBE Vector Fill Opacity",
    "Vector Fill Rule": "ADBE Vector Fill Rule",
    "Vector Grad Colors": "ADBE Vector Grad Colors",
    "Vector Grad End Pt": "ADBE Vector Grad End Pt",
    "Vector Grad HiLite Angle": "ADBE Vector Grad HiLite Angle",
    "Vector Grad HiLite Length": "ADBE Vector Grad HiLite Length",
    "Vector Grad Start Pt": "ADBE Vector Grad Start Pt",
    "Vector Grad Type": "ADBE Vector Grad Type",
    "Vector Layer": "ADBE Vector Layer",
    "Vector Merge Type": "ADBE Vector Merge Type",
    "Vector Offset Amount": "ADBE Vector Offset Amount",
    "Vector Offset Copies": "ADBE Vector Offset Copies",
    "Vector Offset Copy Offset": "ADBE Vector Offset Copy Offset",
    "Vector Offset Line Join": "ADBE Vector Offset Line Join",
    "Vector Offset Miter Limit": "ADBE Vector Offset Miter Limit",
    "Vector Paint": "ADBE Vector Paint",
    "Vector PuckerBloat Amount": "ADBE Vector PuckerBloat Amount",
    "Vector Random Seed": "ADBE Vector Random Seed",
    "Vector Rect Position": "ADBE Vector Rect Position",
    "Vector Rect Roundness": "ADBE Vector Rect Roundness",
    "Vector Rect Size": "ADBE Vector Rect Size",
    "Vector Repeater Copies": "ADBE Vector Repeater Copies",
    "Vector Repeater Offset": "ADBE Vector Repeater Offset",
    "Vector Repeater Order": "ADBE Vector Repeater Order",
    "Vector Roughen Detail": "ADBE Vector Roughen Detail",
    "Vector Roughen Points": "ADBE Vector Roughen Points",
    "Vector Roughen Size": "ADBE Vector Roughen Size",
    "Vector RoundCorner Radius": "ADBE Vector RoundCorner Radius",
    "Vector Spatial Phase": "ADBE Vector Spatial Phase",
    "Vector Star Inner Radius": "ADBE Vector Star Inner Radius",
    "Vector Star Inner Roundess": "ADBE Vector Star Inner Roundess",
    "Vector Star Outer Radius": "ADBE Vector Star Outer Radius",
    "Vector Star Outer Roundess": "ADBE Vector Star Outer Roundess",
    "Vector Star Points": "ADBE Vector Star Points",
    "Vector Star Position": "ADBE Vector Star Position",
    "Vector Star Rotation": "ADBE Vector Star Rotation",
    "Vector Star Type": "ADBE Vector Star Type",
    "Vector Stroke Color": "ADBE Vector Stroke Color",
    "Vector Stroke Dash": "ADBE Vector Stroke Dash 3",
    "Vector Stroke Dashes": "ADBE Vector Stroke Dashes",
    "Vector Stroke Gap": "ADBE Vector Stroke Gap 3",
    "Vector Stroke Line Cap": "ADBE Vector Stroke Line Cap",
    "Vector Stroke Line Join": "ADBE Vector Stroke Line Join",
    "Vector Stroke Miter Limit": "ADBE Vector Stroke Miter Limit",
    "Vector Stroke Offset": "ADBE Vector Stroke Offset",
    "Vector Stroke Opacity": "ADBE Vector Stroke Opacity",
    "Vector Stroke Taper": "ADBE Vector Stroke Taper",
    "Vector Stroke Wave": "ADBE Vector Stroke Wave",
    "Vector Stroke Width": "ADBE Vector Stroke Width",
    "Vector Taper End Ease": "ADBE Vector Taper End Ease",
    "Vector Taper End Length": "ADBE Vector Taper End Length",
    "Vector Taper End Width": "ADBE Vector Taper End Width",
    "Vector Taper Length Units": "ADBE Vector Taper Length Units",
    "Vector Taper Start Ease": "ADBE Vector Taper Start Ease",
    "Vector Taper Start Length": "ADBE Vector Taper Start Length",
    "Vector Taper Start Width": "ADBE Vector Taper Start Width",
    "Vector Taper Wave Amount": "ADBE Vector Taper Wave Amount",
    "Vector Taper Wave Phase": "ADBE Vector Taper Wave Phase",
    "Vector Taper Wave Units": "ADBE Vector Taper Wave Units",
    "Vector Taper Wavelength": "ADBE Vector Taper Wavelength",
    "Vector Temporal Freq": "ADBE Vector Temporal Freq",
    "Vector Temporal Phase": "ADBE Vector Temporal Phase",
    "Vector Trim End": "ADBE Vector Trim End",
    "Vector Trim Offset": "ADBE Vector Trim Offset",
    "Vector Trim Start": "ADBE Vector Trim Start",
    "Vector Trim Type": "ADBE Vector Trim Type",
    "Vector Twist Angle": "ADBE Vector Twist Angle",
    "Vector Twist Center": "ADBE Vector Twist Center",
    "Vector Xform Temporal Freq": "ADBE Vector Xform Temporal Freq",
    "Vector Zigzag Detail": "ADBE Vector Zigzag Detail",
    "Vector Zigzag Points": "ADBE Vector Zigzag Points",
    "Vector Zigzag Size": "ADBE Vector Zigzag Size",
    "Venetian Blinds": "ADBE Venetian Blinds",
    "Vibrance": "ADBE Vibrance",
    "Warp": "ADBE WRPMESH",
    "Warp Stabilizer VFX": "ADBE SubspaceStabilizer",
    "Wave Warp": "ADBE Wave Warp",
    "Wiggle Transform": "ADBE Vector Wiggler Transform",
    "Write-on": "ADBE Write-on",
    "Zig Zag": "ADBE Vector Filter - Zigzag",
    "Zoom": "ADBE Camera Zoom"
};

// Universal property accessor: tries the ADBE match name first (language-independent),
// then the English display name, then known property groups (ADBE Audio Group for
// Audio Levels, ADBE Transform Group for transforms). Returns null if not found.
// 界限（实测）：**Audio Levels 的组回退**只认 ADBE matchName/英文
// 显示名。ADBE_MATCH 是唯一的"名字 → matchName"表，本地化显示名查不到时 matchName 回落成
// 传入的显示名，Audio Group 守卫不命中（getPropSafe(layer, '音频电平') 返回 null）。
// Transform Group 兜底不受此限：matchName 与 displayName 各试一次，本地化显示名经
// property(displayName) 命中（实测 位置/缩放/旋转/不透明度/锚点 全部可达）。
function getPropSafe(parent, displayName) {
    var matchName = ADBE_MATCH[displayName] || displayName;
    // parent.property(matchName) 在某些图层上会【静默返回 null】而非抛异常
    // （如纯色层取 "ADBE Position" 返回 null）。所以每条尝试都必须校验非 null。
    var p = null;
    try { p = parent.property(matchName); } catch (_) {}
    if (p) return p;
    try { p = parent.property(displayName); } catch (_) {}
    if (p) return p;
    // Audio Group 回退（AE 2023 真机）：Audio Levels 既不在图层根
    //（parent.property("ADBE Audio Levels") 直接返回 null），也不在 Transform Group 下，
    // 而在 ADBE Audio Group 里（该组在纯色层上同样存在，numProperties=1）。必须经组子查。
    // 只有 Audio Levels 走这一跳：其余属性多一跳就是整层扫描多付一次宿主调用。
    // 守卫判据是**解析后的 matchName**（ADBE_MATCH 查表结果），所以英文显示名 "Audio Levels"
    // 与 ADBE matchName 都能触发；本地化显示名（如「音频电平」）ADBE_MATCH 无此键 → matchName
    // 回落成显示名 → 不触发（返回 null）。那是函数契约限制（见函数头注释），此处不猜语言。
    if (matchName === ADBE_MATCH["Audio Levels"]) {
        var audf = null;
        try { audf = parent.property(ADBE_MATCH["Audio"] || "ADBE Audio Group"); } catch (_) {}
        if (audf) {
            try { p = audf.property(matchName); } catch (_) {}
            if (p) return p;
            try { p = audf.property(displayName); } catch (_) {}
            if (p) return p;
        }
    }
    // Transform Group 兜底：Position/Scale/Rotation/Opacity/Anchor Point 等属性
    // 挂载在 Transform Group 下，parent 一层直接查不到。走 ADBE Transform Group 子查。
    var txf = null;
    try { txf = parent.property(ADBE_MATCH["Transform"]); } catch (_) {}
    if (txf) {
        try { p = txf.property(matchName); } catch (_) {}
        if (p) return p;
        try { p = txf.property(displayName); } catch (_) {}
        if (p) return p;
    }
    return null;
}

// 在指定父级下查找子属性：优先 matchName（跨语言稳定），回退英文显示名。
// 用于 ADBE_MATCH 未覆盖、或同一显示名在不同父级下有不同 matchName 的场景
// （如形状的 Size/Color、灯光的 Color）。
function getSubProp(parent, matchName, displayName) {
    var p = null;
    try { p = parent.property(matchName); } catch (_) {}
    if (p) return p;
    if (displayName && displayName !== matchName) {
        try { p = parent.property(displayName); } catch (_) {}
    }
    return p;
}

// Find a property on a layer by name, with Transform group fallback.
// Tries ADBE match name first, then English name, then inside Transform group.

// Find an effect by name (supports both English and localized display names + matchName)
function findEffectByName(effects, effectName) {
    var matchName = ADBE_MATCH[effectName] || effectName;
    for (var i = 1; i <= effects.numProperties; i++) {
        var eff = effects.property(i);
        if (eff.name === effectName || eff.matchName === matchName) return eff;
    }
    return null;
}

function getLayerTarget(args) {
    var comp = getCompOrThrow(args);
    // 稳定键优先：layerId（配合 compositionId）。id 给了却解析不到 → 抛错，
    // 不退回位置键/名字（那是另一层），调用方据此纠正而不是改错层。
    var wantLayerId = (args && args.layerId !== undefined && args.layerId !== null)
        ? Math.floor(Number(args.layerId)) : 0;
    if (wantLayerId > 0) {
        var byIdLayer = _findLayerById(comp, wantLayerId);
        if (byIdLayer) return { comp: comp, layer: byIdLayer };
        throw new Error("Layer id not found in comp \"" + comp.name + "\" (deleted or moved?): " + wantLayerId);
    }
    var layerIndex = args && args.layerIndex !== undefined && args.layerIndex !== null ? Number(args.layerIndex) : 0;
    var layerName = args && args.layerName ? String(args.layerName) : "";
    if (layerIndex > 0 && layerIndex <= comp.numLayers) return { comp: comp, layer: comp.layer(layerIndex) };
    if (layerName) {
        for (var j = 1; j <= comp.numLayers; j++) {
            if (comp.layer(j).name === layerName) return { comp: comp, layer: comp.layer(j) };
        }
    }
    throw new Error("Layer not found: " + (layerName || "index " + layerIndex));
}

function getProjectInfo(args) {
    try {
        var comps = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem) {
                comps.push({ name: item.name, width: item.width, height: item.height, duration: item.duration, frameRate: item.frameRate });
            }
        }
        var activeComp = null;
        if (app.project.activeItem instanceof CompItem) {
            var ai = app.project.activeItem;
            activeComp = { name: ai.name, width: ai.width, height: ai.height, frameRate: ai.frameRate, duration: ai.duration };
            // 当前时间指示（CTI），秒
            try { activeComp.currentTime = ai.time; } catch (_) { activeComp.currentTime = null; }
            // 用户当前选中的属性（上限 15 条，超出带 selectedPropertiesTotal 总数；单项读取 try/catch 防护）
            var selProps = [];
            var selTotal = 0;
            try {
                var sp = ai.selectedProperties;
                if (sp && sp.length > 0) {
                    selTotal = sp.length;
                    var maxSel = selTotal < 15 ? selTotal : 15;
                    for (var si = 0; si < maxSel; si++) {
                        try {
                            var p = sp[si];
                            var entry = { name: String(p.name), matchName: String(p.matchName), propertyDepth: p.propertyDepth };
                            // 沿 parentProperty 上溯到所在图层取 layerIndex
                            // （PropertyGroup 无 .index，AVLayer 等有 .index 与 .containingComp，以此判图层）
                            var cur = p, hops = 0;
                            while (cur && hops < 60) {
                                var isLayer = false;
                                try { isLayer = (typeof cur.index === "number") && (cur.containingComp instanceof CompItem); } catch (_) { isLayer = false; }
                                if (isLayer) { try { entry.layerIndex = cur.index; } catch (_) {} break; }
                                var par = null;
                                try { par = cur.parentProperty; } catch (_) { par = null; }
                                if (!par) break;
                                cur = par; hops++;
                            }
                            selProps.push(entry);
                        } catch (_) { /* 部分属性读 matchName 会抛异常，跳过该项 */ }
                    }
                }
            } catch (_) {}
            activeComp.selectedProperties = selProps;
            if (selTotal > selProps.length) activeComp.selectedPropertiesTotal = selTotal;
        }
        return { status: "success", appVersion: app.version, compositionCount: comps.length, compositions: comps, activeComposition: activeComp };
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

// 轻量查询：仅返回活动合成摘要（名称/尺寸/帧率/时长/时间指针/选中属性）。
// 供 AE 上下文快照（aeContext.gather）使用，避免把整个项目合成列表带入上下文。
function getActiveCompInfo(args) {
    var info = getProjectInfo(args);
    if (info.status !== "success") return info;
    return { status: "success", activeComposition: info.activeComposition || null };
}

// 收集属性的关键帧列表：time/value/插值类型/空间切线/时间缓动。
// 无关键帧返回空数组。easing 按属性维度展开（多维属性每维一个 {speed,influence}）。
// 曲线语义：interpolationIn/interpolationOut 走 KeyframeInterpolationType
// （linear/bezier/hold，命名与 queryDetails(target=effect) 的 keyframeList 一致）；
// spatialIn/spatialOut 是 3 元空间切线（2D 层 z 补 0），只有位置类空间属性可读——
// 非空间属性调用即抛异常，逐字段 try 后省略；三个空间关键帧标志同理。
// 窗口：可选 from（0-based 起始）+ count（条数），只构造该窗口，
// 不整份构造后截断（3000 键层不会一次构造 3000 个记录）。不传 = 全量。
function collectKeyframes(prop, from, count) {
    // KeyframeInterpolationType 常量 → 名字；常量表不可用时回退原始值字符串
    function interpName(v) {
        try {
            if (v === KeyframeInterpolationType.LINEAR) return "linear";
            if (v === KeyframeInterpolationType.BEZIER) return "bezier";
            if (v === KeyframeInterpolationType.HOLD) return "hold";
        } catch (_) {}
        return String(v);
    }
    // 空间切线 → [x,y,z]：2 元补 0；空值返回 null（调用方据此省略字段）
    function spatialVec(arr) {
        if (!arr || !arr.length) return null;
        return [arr[0], (arr.length > 1 ? arr[1] : 0), (arr.length > 2 ? arr[2] : 0)];
    }
    var kfs = [];
    try {
        var n = prop.numKeys;
        // 窗口边界：from 省略/非正 → 从第 1 键起；count 省略/非正 → 到末键；均按 1-based 序号
        var startAt = 1;
        var stopAt = n;
        if (typeof from === "number" && isFinite(from) && from > 0) startAt = Math.floor(from) + 1;
        if (typeof count === "number" && isFinite(count) && count > 0) stopAt = startAt + Math.floor(count) - 1;
        else if (startAt > 1) stopAt = n;
        if (stopAt > n) stopAt = n;
        if (startAt > n) startAt = n + 1;
        for (var i = startAt; i <= stopAt; i++) {
            var kf = { time: prop.keyTime(i), value: prop.keyValue(i) };
            try { kf.interpolationIn = interpName(prop.keyInInterpolationType(i)); } catch (_) {}
            try { kf.interpolationOut = interpName(prop.keyOutInterpolationType(i)); } catch (_) {}
            // 空间切线/空间关键帧标志只对空间属性存在；非空间属性这里抛异常 → 字段省略
            try { var sIn = spatialVec(prop.keyInSpatialTangent(i)); if (sIn) kf.spatialIn = sIn; } catch (_) {}
            try { var sOut = spatialVec(prop.keyOutSpatialTangent(i)); if (sOut) kf.spatialOut = sOut; } catch (_) {}
            try { kf.spatialAutoBezier = prop.keySpatialAutoBezier(i) ? true : false; } catch (_) {}
            try { kf.spatialContinuous = prop.keySpatialContinuous(i) ? true : false; } catch (_) {}
            try { kf.roving = prop.keyRoving(i) ? true : false; } catch (_) {}
            // 官方 API 是 keyInTemporalEase/keyOutTemporalEase（无 keyTemporalEase）
            try {
                var inEases = prop.keyInTemporalEase(i);
                var outEases = prop.keyOutTemporalEase(i);
                var easeIn = [], easeOut = [];
                for (var e = 0; e < inEases.length; e++) {
                    easeIn.push({ speed: inEases[e].speed, influence: inEases[e].influence });
                }
                for (var e2 = 0; e2 < outEases.length; e2++) {
                    easeOut.push({ speed: outEases[e2].speed, influence: outEases[e2].influence });
                }
                kf.easeIn = easeIn;
                kf.easeOut = easeOut;
            } catch (_) {}
            kfs.push(kf);
        }
    } catch (_) {}
    return kfs;
}

// 参数值的可读形态：严格校验的报错文案要能区分字符串 "1" 与数字 1。
// String(v) 把两者印成同一个 1，调用方按文案改参数会改错方向（把 number 改成 string）。
// 形态：字符串 "1" / 数字 1 / 布尔 true / null / undefined / 数组(2) / 对象 / 函数；
// 字符串超 40 字符截断加省略号——长表达式或中文路径不把一句报错撑成正文。
// 命名以 _ 开头：私有顶层名，须登记 _INTERNAL_NAMES / PRIVATE_NAMES（完备性兜底）。
function _describeArgValue(v) {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (_isArrayValue(v)) return "数组(" + v.length + ")";
    var t = typeof v;
    if (t === "string") {
        var s = String(v);
        if (s.length > 40) s = s.substring(0, 40) + "...";
        return "字符串 \"" + s + "\"";
    }
    if (t === "number") return "数字 " + String(v);
    if (t === "boolean") return "布尔 " + String(v);
    if (t === "function") return "函数";
    return "对象";
}

// 查询类工具的严格合成定位：comp / layer / effect /
// queryProject(layers|overview) 全部走本函数。旧的宽松 `_resolveQueryComp` 已删除——它对
// compositionId 做 `Math.floor(Number(...))`，让 true→1、"922"→922、1.5→1 静默命中别的合成，
// 与 target=layer/effect 的严格语义两套并存。
// compositionId（稳定键）优先于 compositionIndex，compIndex 是历史内部别名；两者都给时以 id 为准
//（既有规则）。值必须是 **number 类型的正整数**：字符串/布尔/浮点/0/越界/指向非合成一律报错并
// 用 _describeArgValue 点明收到的值（字符串 "1" 与数字 1 可区分）——旧路径经 getActiveComp 的
// `Number(...)` + `Math.floor(...)`，让 true→1、"1"→1、1.5→1、0/负数退回活动合成，
// 调用方传到错合成却收到 success（target=layer/effect 曾如此）。
// 两个键都没给：allowActiveComp=true（effect，既有行为）回退活动合成；false（comp/layer/
// queryProject）报错，不静默查别的合成（查错合成看起来像成功最误导）。
function _resolveStrictComp(args, allowActiveComp) {
    args = args || {};
    var hasCompId = (args.compositionId !== undefined && args.compositionId !== null);
    if (hasCompId) {
        var idRaw = args.compositionId;
        if (typeof idRaw !== "number" || !isFinite(idRaw) || idRaw !== Math.floor(idRaw) || idRaw < 1) {
            return { error: "compositionId 必须是正整数（收到 " + _describeArgValue(idRaw) + "）" };
        }
        var byIdComp = _findItemById(idRaw);
        if (!(byIdComp instanceof CompItem)) {
            return { error: "compositionId 找不到对应合成（可能已删除）: " + idRaw };
        }
        return { comp: byIdComp, compIdx: _getItemIndex(byIdComp) };
    }
    var hasCompIndex = (args.compositionIndex !== undefined && args.compositionIndex !== null);
    var hasLegacyIndex = (args.compIndex !== undefined && args.compIndex !== null);
    if (hasCompIndex || hasLegacyIndex) {
        var idxKey = hasCompIndex ? "compositionIndex" : "compIndex";
        var idxRaw = hasCompIndex ? args.compositionIndex : args.compIndex;
        if (typeof idxRaw !== "number" || !isFinite(idxRaw) || idxRaw !== Math.floor(idxRaw) || idxRaw < 1) {
            return { error: idxKey + " 不是正整数索引: " + _describeArgValue(idxRaw) };
        }
        if (idxRaw > app.project.numItems) {
            return { error: idxKey + " 越界: " + idxRaw + "（项目条目数 " + app.project.numItems + "）" };
        }
        var compAtIdx = null;
        try { compAtIdx = app.project.item(idxRaw); } catch (_) { compAtIdx = null; }
        if (!(compAtIdx instanceof CompItem)) return { error: idxKey + " 不是合成: " + idxRaw };
        return { comp: compAtIdx, compIdx: idxRaw };
    }
    if (allowActiveComp) {
        var activeComp = null;
        try { if (app.project.activeItem instanceof CompItem) activeComp = app.project.activeItem; } catch (_) { activeComp = null; }
        if (activeComp) return { comp: activeComp, compIdx: _getItemIndex(activeComp) };
        return { error: "没有活动合成，且未提供 compositionIndex 或 compositionId" };
    }
    return { error: "需要 compositionIndex 或 compositionId" };
}

// ids 数组校验的唯一持有者：queryDetails 的 layerIds / compositionIds /
// footageIds 与 queryProject(target=overview) 的 compositionIds 四处共用（target=comp 的 ids
// 走本函数，layer/footage 同理）。契约：必须是数组且非空；元素只能是 number 或纯数字字符串
// 的正整数，布尔/数组/对象/浮点/空串一律报错并点名第几项——裸调 _findItemById 时
// Math.floor(Number(true))→1、[922.9]→922，静默命中别的对象；空数组则返回 0 条 success，
// 看起来像「这些对象不存在」。值的解析（是否合成/素材、失效文案）仍由各调用方负责。
function _resolveItemIds(list, label) {
    if (!_isArrayValue(list)) return { error: label + " 需为数组" };
    if (list.length === 0) return { error: label + " 不能为空数组" };
    var ids = [];
    for (var i = 0; i < list.length; i++) {
        var raw = list[i];
        var id = NaN;
        if (typeof raw === "number") id = raw;
        else if (typeof raw === "string" && /^\d+$/.test(raw)) id = Number(raw);
        if (!isFinite(id) || id !== Math.floor(id) || id < 1) {
            return { error: label + " 第 " + (i + 1) + " 项不是正整数 id: " + _describeArgValue(raw) };
        }
        ids.push(id);
    }
    return { ids: ids };
}

function listLayers(args) {
    try {
        args = args || {};
        // 合成定位：与 target=layer/comp/effect 共用 _resolveStrictComp——compositionId
        // 优先，其次 compositionIndex/compIndex；值必须 number 正整数，字符串/布尔/浮点/0 报错
        //（旧路径 _resolveQueryComp 对 "922"/true/1.5 归一后静默查别的合成）。不回退活动合成。
        var _rc = _resolveStrictComp(args, false);
        if (_rc.error) return { status: "error", message: _rc.error };
        var comp = _rc.comp;
        var compIdx = _rc.compIdx;
        var n = comp.numLayers;
        // 过滤参数：layerType 按类型过滤，layerName 按名称子串匹配（大小写不敏感）
        var filterType = args.layerType ? String(args.layerType).toLowerCase() : '';
        var filterName = args.layerName ? String(args.layerName).toLowerCase() : '';
        // 先全量遍历收集+过滤
        var allLayers = [];
        for (var i = 1; i <= n; i++) {
            var layer = comp.layer(i);
            var layerType = "unknown";
            try {
                if (layer instanceof TextLayer) layerType = "text";
                else if (layer instanceof ShapeLayer) layerType = "shape";
                else if (layer instanceof CameraLayer) layerType = "camera";
                else if (layer instanceof LightLayer) layerType = "light";
                else if (layer instanceof AVLayer) {
                    if (layer.nullLayer) layerType = "null";
                    else if (layer.adjustmentLayer) layerType = "adjustment";
                    else layerType = "av";
                }
            } catch (_) {}
            // 类型过滤
            if (filterType && layerType !== filterType) continue;
            // 名称过滤（子串匹配，大小写不敏感）
            if (filterName) {
                var lname = '';
                try { lname = String(layer.name).toLowerCase(); } catch (_) {}
                if (lname.indexOf(filterName) < 0) continue;
            }
            var entry = {
                index: layer.index,
                layerId: _readLayerId(layer),
                name: layer.name,
                layerType: layerType,
                enabled: layer.enabled,
                isHidden: layer.shy,
                isLocked: layer.locked,
                isSoloed: layer.solo,
                is3D: layer.threeDLayer,
                hasVideo: layer.hasVideo,
                hasAudio: layer.hasAudio,
                inPoint: layer.inPoint,
                outPoint: layer.outPoint,
                startTime: layer.startTime,
                duration: layer.duration,
                stretch: layer.stretch,
                label: layer.label,
                // 模糊层：有无轨道遮罩 + 混合模式名，不必进详情即可筛层。
                // 旧版 AE 无 trackMatteLayer 时读异常 → hasTrackMatte=false（详情层才区分"无此概念"）。
                hasTrackMatte: (function () {
                    try { return !!(layer instanceof AVLayer && layer.trackMatteLayer); } catch (_) { return false; }
                })(),
                blendingMode: (function () {
                    try { return _blendModeName(layer.blendingMode); } catch (_) { return ''; }
                })()
            };
            try {
                entry.parent = layer.parent ? { index: layer.parent.index, name: layer.parent.name } : null;
            } catch (_) { entry.parent = null; }
            if (layerType === "av" || layerType === "adjustment") {
                try {
                    var src = layer.source;
                    if (src) {
                        // source 补稳定键 id（Item.id）——只给 index 时，调用方跨调用
                        // 定位来源（嵌套合成/素材）只能靠会移位的项目面板索引；index 保留兼容。
                        entry.source = { name: src.name, sourceKind: _getSourceKind(src), duration: src.duration, index: _getItemIndex(src), id: _readItemId(src) };
                    }
                } catch (_) {}
            }
            allLayers.push(entry);
        }
        // 分页：对过滤后的图层列表分页（layerOffset/layerLimit，默认 30，上限 100）
        // 下限 1：0.5 > 0 成立但 floor 后为 0 → 本页 0 条而 hasMore=true、
        // offset 永不前进（续页死循环）。正数一律至少取 1；非 number/非有限/≤0 回退默认。
        var offset = (typeof args.layerOffset === "number" && isFinite(args.layerOffset) && args.layerOffset > 0)
            ? Math.floor(args.layerOffset) : 0;
        var limit = (typeof args.layerLimit === "number" && isFinite(args.layerLimit) && args.layerLimit > 0)
            ? Math.max(1, Math.floor(args.layerLimit)) : 30;
        if (limit > 100) limit = 100;
        var totalCount = allLayers.length;
        var startIdx = offset;
        var endIdx = offset + limit;
        if (startIdx > totalCount) startIdx = totalCount;
        if (endIdx > totalCount) endIdx = totalCount;
        var layers = allLayers.slice(startIdx, endIdx);
        // 内容摘要只对**返回页**计算：放在分页前等于对全部过滤图层算——千层合成
        // 一次查 5 层也要算千份，单层约 40–50 次宿主调用会拖住 AE。用 layer.index 回取图层，
        // entry 本身不携带 AE 对象引用（避免结果对象里混入不可序列化引用）。
        if (args.includeContent !== false) {
            for (var ci = 0; ci < layers.length; ci++) {
                try {
                    var cLayer = comp.layer(layers[ci].index);
                    if (cLayer) {
                        layers[ci].content = _getLayerContentSummary(cLayer);
                        // 动画指纹：与 content 同级，回答"动没动、动在哪些属性、跨多少帧"
                        layers[ci].anim = _getLayerAnimSummary(cLayer);
                    }
                } catch (_) {}
            }
        }
        // 单页字节预算：100 层 layers 61,314 字符（默认 30 层约 21KB
        // 不越线，显式最大分页才触发）。两级收缩，先保身份再保摘要：
        //   ① 从尾部剥每条的 content/anim 载荷（该条置 contentOmitted=true）——图层身份
        //      （index/layerId/name/type）保留，调用方不会「以为只选了 N 层」；
        //   ② 仍超预算才从尾部丢整条（至少留 1 条防续页死循环）。
        // 任何一级收缩都置 bytesTruncated=true；hasMore 按实际返回数前进，nextOffset 续页不重不漏。
        var PAGE_BYTE_BUDGET = 12000;
        var _pageSizes = [];
        var _pageBytes = 2;
        var _bytesTruncated = false;
        for (var _pli = 0; _pli < layers.length; _pli++) {
            var _plb = 0;
            try { _plb = JSON.stringify(layers[_pli]).length; } catch (_) { _plb = 0; }
            _pageSizes[_pli] = _plb;
            _pageBytes += _plb + (_pli > 0 ? 1 : 0);
        }
        if (_pageBytes > PAGE_BYTE_BUDGET) {
            for (var _psi = layers.length - 1; _psi >= 0 && _pageBytes > PAGE_BYTE_BUDGET; _psi--) {
                var _pEnt = layers[_psi];
                if (!_pEnt || (_pEnt.content === undefined && _pEnt.anim === undefined)) continue;
                var _pBefore = _pageSizes[_psi];
                try { delete _pEnt.content; delete _pEnt.anim; } catch (_) {}
                _pEnt.contentOmitted = true;
                var _pAfter = 0;
                try { _pAfter = JSON.stringify(_pEnt).length; } catch (_) { _pAfter = _pBefore; }
                _pageBytes -= (_pBefore - _pAfter);
                _pageSizes[_psi] = _pAfter;
                _bytesTruncated = true;
            }
        }
        var _pageKeep = layers.length;
        while (_pageKeep > 1 && _pageBytes > PAGE_BYTE_BUDGET) {
            _pageKeep--;
            _pageBytes -= (_pageSizes[_pageKeep] + 1);
            _bytesTruncated = true;
        }
        // 只剩 1 条仍超预算：如实标注（不再继续砍，砍成 0 会让 nextOffset 原地）
        if (_pageBytes > PAGE_BYTE_BUDGET) _bytesTruncated = true;
        var _pageLayers = layers.slice(0, _pageKeep);
        var _nextOffset = offset + _pageLayers.length;
        var _listResult = {
            status: "success",
            compName: comp.name,
            count: _pageLayers.length,
            totalCount: totalCount,
            layers: _pageLayers,
            layerOffset: offset,
            layerLimit: limit,
            hasMore: _nextOffset < totalCount,
            nextOffset: _nextOffset
        };
        if (_bytesTruncated) _listResult.bytesTruncated = true;
        return _listResult;
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

// ── 图层「可深挖内容」摘要（queryProject 的 layers/selected 用）──────────
// 职责：模糊查询阶段就能判断该层有没有值得 queryDetails 的东西（效果参数 / 蒙版路径 /
// 文本动画 / 图层样式 / 关键帧），不必先查详情再决定。
// 成本：每层约 40–60 次属性访问（5 个变换属性 + Audio Levels（经 ADBE Audio Group 一跳）
// + 效果/蒙版/文本组计数 + 11 个样式开关，
// 每个组开关要 property(i) → matchName → enabled 三次宿主调用），只读计数不读明细；
// 默认开启，传 includeContent:false 可关。
function _countTransformKeyframes(layer) {
    var n = 0;
    var names = ["Position", "Scale", "Rotation", "Opacity", "Anchor Point", "Audio Levels"];
    for (var i = 0; i < names.length; i++) {
        try {
            var p = getPropSafe(layer, names[i]);
            if (p && typeof p.numKeys === "number") n += p.numKeys;
        } catch (_) {}
    }
    // Time Remap 与 anim.keys 同口径：AVLayer 且已启用时属性存在。
    // 蒙版关键帧两处都不计（仍在 content.masks 与 unscanned 里说明）。
    try {
        if (layer instanceof AVLayer && layer.timeRemapEnabled) {
            var tr = getPropSafe(layer, "Time Remap");
            if (tr && typeof tr.numKeys === "number") n += tr.numKeys;
        }
    } catch (_) {}
    return n;
}

// 已启用的图层样式数。真机结构（AE 2023）：每层都有 "ADBE Layer Styles" 组，固定 11 个子组 =
// 混合选项 + 10 种样式（投影/内阴影/外发光/内发光/斜面和浮雕/光泽/颜色叠加/渐变叠加/图案叠加/描边），
// 未启用的样式也占位、靠子组 enabled 判断；混合选项不是样式，按 matchName 排除。
function _countEnabledLayerStyles(layer) {
    var n = 0;
    try {
        var g = layer.property("ADBE Layer Styles");
        for (var i = 1; i <= g.numProperties; i++) {
            var s = g.property(i);
            var mn = "";
            try { mn = String(s.matchName || ""); } catch (_) {}
            if (mn === "ADBE Blend Options Group") continue;
            try { if (s.enabled === true) n++; } catch (_) {}
        }
    } catch (_) {}
    return n;
}

function _getLayerContentSummary(layer) {
    var summary = {
        effects: 0,
        masks: 0,
        keyframes: _countTransformKeyframes(layer),
        text: false,
        textAnimators: 0,
        layerStyles: _countEnabledLayerStyles(layer)
    };
    try {
        var fx = getPropSafe(layer, "Effects");
        if (fx) summary.effects = fx.numProperties;
    } catch (_) {}
    try {
        var mg = getPropSafe(layer, "Masks");
        if (mg) summary.masks = mg.numProperties;
    } catch (_) {}
    try {
        if (layer instanceof TextLayer) {
            summary.text = true;
            var tp = layer.property("ADBE Text Properties");
            try {
                var an = tp.property("ADBE Text Animators");
                if (an) summary.textAnimators = an.numProperties;
            } catch (_) {}
            try {
                var sd = tp.property("ADBE Text Document");
                if (sd && sd.numKeys > 0) summary.keyframes += sd.numKeys;
            } catch (_) {}
        }
    } catch (_) {}
    return summary;
}

// ── 图层动画指纹（queryProject 的 layers/selected 用）────────
// 与 content 同级：content 回答"这层有没有可深挖的内容"，anim 回答"这层动没动、动在
// 哪些属性、跨多少合成帧"。扫描面与 comp 事件表一致——5 个变换属性（Position/Scale/
// Rotation/Opacity/Anchor Point）+ Audio Levels（在 ADBE Audio Group 下，经 getPropSafe
// 的组回退读取）+ Time Remap（AVLayer 且已启用）+ 文本层 Source Text；只读 numKeys /
// keyTime / expression 存在性，不读值、不读曲线
//（值、曲线、逐键时间仍归 queryDetails）。蒙版/效果/形状/文本动画器/图层样式不扫，
// 在 unscanned 里明列（不按 0 计）。每层约 50–60 次宿主调用，默认开；includeContent:false
// 同时关掉 content 与 anim（同一扫描开关）。
function _getLayerAnimSummary(layer) {
    var transformNames = ["Position", "Scale", "Rotation", "Opacity", "Anchor Point", "Audio Levels"];
    // props 上限 8：扫描面本身恰好 8 个属性（5 个变换属性 + Audio Levels + Time Remap +
    // Source Text），正常不会截断，propsTruncated 是防御性标记（扫描面以后扩属性时才有意义）。
    var anim = {
        props: [],
        tracks: 0,
        keys: 0,
        spanFrames: null,
        hasExpression: false,
        nested: null,
        scanned: [],
        unscanned: ["masks", "effects", "shapeContents", "textAnimatorParams", "layerStyles"]
    };
    var fps = 0;
    try { fps = Number(layer.containingComp.frameRate) || 0; } catch (_) { fps = 0; }
    var startTime = 0;
    try { startTime = Number(layer.startTime) || 0; } catch (_) { startTime = 0; }
    var stretch = 100;
    try { stretch = Number(layer.stretch); } catch (_) { stretch = 100; }
    if (isNaN(stretch)) stretch = 100;
    // stretch≠100：层时间与合成时间非线性，关键帧没有统一的合成帧换算——不猜，只标记并省略 spanFrames
    var nonLinear = (stretch !== 100);
    if (nonLinear) anim.spanNonLinear = true;
    var firstFrame = null;
    var lastFrame = null;
    var propCount = 0;
    // 一个属性：读 numKeys / expression。有键或表达式才进 props；tracks 只数有键的属性。
    // 关键帧时间换算成合成帧（round((startTime + keyTime) × 合成帧率)），只用于首末跨度。
    function _animPropStat(prop, label) {
        if (!prop) return false;
        var n = 0;
        try { n = Number(prop.numKeys) || 0; } catch (_) { n = 0; }
        var hasExpr = false;
        try {
            var expr = prop.expression;
            hasExpr = (expr !== undefined && expr !== null && String(expr) !== "");
        } catch (_) { hasExpr = false; }
        if (hasExpr) anim.hasExpression = true;
        if (n > 0 || hasExpr) {
            if (propCount < 8) anim.props.push(label);
            else anim.propsTruncated = true;
            propCount++;
        }
        if (n > 0) {
            anim.tracks++;
            anim.keys += n;
            if (!nonLinear && fps > 0) {
                for (var ki = 1; ki <= n; ki++) {
                    var kt = 0;
                    try { kt = Number(prop.keyTime(ki)); } catch (_) { continue; }
                    var f = Math.round((startTime + kt) * fps);
                    if (!isFinite(f)) continue;
                    if (firstFrame === null || f < firstFrame) firstFrame = f;
                    if (lastFrame === null || f > lastFrame) lastFrame = f;
                }
            }
        }
        return true;
    }
    var scannedTransform = false;
    for (var ti = 0; ti < transformNames.length; ti++) {
        var tProp = null;
        try { tProp = getPropSafe(layer, transformNames[ti]); } catch (_) { tProp = null; }
        if (_animPropStat(tProp, transformNames[ti])) scannedTransform = true;
    }
    if (scannedTransform) anim.scanned.push("transform");
    var scannedTimeRemap = false;
    try {
        if (layer instanceof AVLayer && layer.timeRemapEnabled) {
            scannedTimeRemap = _animPropStat(getPropSafe(layer, "Time Remap"), "Time Remap");
        }
    } catch (_) { scannedTimeRemap = false; }
    if (scannedTimeRemap) anim.scanned.push("timeRemap");
    var scannedSourceText = false;
    try {
        if (layer instanceof TextLayer) {
            var textProps = layer.property("ADBE Text Properties");
            var srcDoc = textProps ? textProps.property("ADBE Text Document") : null;
            scannedSourceText = _animPropStat(srcDoc, "Source Text");
        }
    } catch (_) { scannedSourceText = false; }
    if (scannedSourceText) anim.scanned.push("sourceText");
    // 嵌套合成：只记来源，不递归子合成（子合成里的动画标 unknown——诚实标注，不假装 0）
    try {
        if (layer instanceof AVLayer) {
            var srcComp = layer.source;
            if (srcComp instanceof CompItem) {
                anim.nested = { isPrecomp: true, subCompId: _readItemId(srcComp), subCompName: "", animation: "unknown" };
                try { anim.nested.subCompName = String(srcComp.name); } catch (_) {}
            }
        }
    } catch (_) {}
    // stretch≠100 的层没有统一换算：省略 spanFrames（undefined ≠ null——null 表"扫过但没有键"）
    if (nonLinear) delete anim.spanFrames;
    else if (firstFrame !== null) anim.spanFrames = { first: firstFrame, last: lastFrame };
    return anim;
}

// 蒙版形状（Mask Path）读取：当前时刻（CTI）形态 + 关键帧。顶点数组可能很大，默认只给数量；
// includeVertices=true 才展开 [[x,y],...]（对应 queryDetails 的 includeMaskVertices 参数）。
// 窗口：kfOffset/kfLimit 与 collectKeyframes 同口径，只构造该窗口的
// 关键帧（3000 键蒙版也只构造窗口内记录）；随附 keyframesTotal/Offset/Limit/HasMore/Truncated，
// 供续页与前缀判断。不传 = 全量（旧行为；HasMore 恒 false）。
// 顶点上限：includeVertices=true 时单个 5000 顶点蒙版 85,085B——
// vertexLimit 默认 200、上限 2000，超出只给前 vertexLimit 个顶点，vertexCount 仍是真实数，
// 并置 verticesTruncated（静态形态在 out 上，关键帧形态在 k 上，同名同义）。
function _readMaskShape(shapeProp, includeVertices, kfOffset, kfLimit, vertexLimit) {
    var _vertexLimit = 200;
    if (typeof vertexLimit === "number" && isFinite(vertexLimit) && vertexLimit > 0) {
        _vertexLimit = Math.max(1, Math.floor(vertexLimit));
    }
    if (_vertexLimit > 2000) _vertexLimit = 2000;
    // 取前 _vertexLimit 个顶点：{ list, truncated }；顶点对象是宿主给的两元素数组，按项拷贝
    function takeVertices(verts) {
        var n = 0;
        try { n = Number(verts.length) || 0; } catch (_) { n = 0; }
        if (n <= _vertexLimit) return { list: verts, truncated: false };
        var list = [];
        for (var vi = 0; vi < _vertexLimit; vi++) list.push(verts[vi]);
        return { list: list, truncated: true };
    }
    // 插值类型命名与 collectKeyframes / target=effect 的 keyframeList 一致
    function interpName(v) {
        try {
            if (v === KeyframeInterpolationType.LINEAR) return "linear";
            if (v === KeyframeInterpolationType.BEZIER) return "bezier";
            if (v === KeyframeInterpolationType.HOLD) return "hold";
        } catch (_) {}
        return String(v);
    }
    var out = { vertexCount: 0, closed: false, keyframes: [] };
    try {
        var v = shapeProp.value;
        if (v && v.vertices) {
            out.vertexCount = v.vertices.length;
            out.closed = (v.closed === true);
            if (includeVertices) {
                var _vt = takeVertices(v.vertices);
                out.vertices = _vt.list;
                out.vertexLimit = _vertexLimit;
                if (_vt.truncated) out.verticesTruncated = true;
            }
        }
    } catch (_) {}
    try {
        var _total = Number(shapeProp.numKeys) || 0;
        var _off = (typeof kfOffset === "number" && isFinite(kfOffset) && kfOffset > 0) ? Math.floor(kfOffset) : 0;
        if (_off > _total) _off = _total;
        var _from = _off + 1;
        var _to = _total;
        if (typeof kfLimit === "number" && isFinite(kfLimit) && kfLimit > 0) _to = _off + Math.floor(kfLimit);
        if (_to > _total) _to = _total;
        for (var i = _from; i <= _to; i++) {
            var k = { time: shapeProp.keyTime(i), vertexCount: 0, closed: false };
            // 蒙版路径是形状属性：只有插值类型，没有空间切线字段
            try { k.interpolationIn = interpName(shapeProp.keyInInterpolationType(i)); } catch (_) {}
            try { k.interpolationOut = interpName(shapeProp.keyOutInterpolationType(i)); } catch (_) {}
            try {
                var kv = shapeProp.keyValue(i);
                if (kv && kv.vertices) {
                    k.vertexCount = kv.vertices.length;
                    k.closed = (kv.closed === true);
                    if (includeVertices) {
                        var _kvt = takeVertices(kv.vertices);
                        k.vertices = _kvt.list;
                        if (_kvt.truncated) k.verticesTruncated = true;
                    }
                }
            } catch (_) {}
            out.keyframes.push(k);
        }
        // 窗口元数据（键集为空时也照给：调用方不必判 undefined）
        out.keyframesTotal = _total;
        out.keyframesOffset = _off;
        out.keyframesLimit = (typeof kfLimit === "number" && isFinite(kfLimit) && kfLimit > 0) ? Math.floor(kfLimit) : _total;
        out.keyframesHasMore = (_off + out.keyframes.length) < _total;
        if (_off > 0 || out.keyframesHasMore) out.keyframesTruncated = true;
    } catch (_) {}
    return out;
}

// 文本动画器（Text Animators）：每个动画器的属性与范围选择器。
// 逐字样式（getStyleAt）在 AST 门白名单外、不可脚本回读，能读到的就是这层结构 + 值。
// 窗口：可选 from（0-based）+ count，与 collectKeyframes / _readSourceTextKeyframes
// 同口径，只构造该页动画器；不传时仍是整份（旧调用行为不变）。
function _readTextAnimators(tp, from, count) {
    var out = [];
    var an = null;
    try { an = tp.property("ADBE Text Animators"); } catch (_) {}
    if (!an) return out;
    var _startAt = (typeof from === "number" && isFinite(from) && from > 0) ? Math.floor(from) + 1 : 1;
    var _stopAt = 0;
    try { _stopAt = Number(an.numProperties) || 0; } catch (_) { _stopAt = 0; }
    if (typeof count === "number" && isFinite(count) && count > 0) {
        var _windowEnd = _startAt + Math.floor(count) - 1;
        if (_windowEnd < _stopAt) _stopAt = _windowEnd;
    }
    for (var i = _startAt; i <= _stopAt; i++) {
        var a = null;
        try { a = an.property(i); } catch (_) {}
        if (!a) continue;
        var rec = { name: "", matchName: "", properties: [], selectors: [] };
        try { rec.name = String(a.name || ""); } catch (_) {}
        try { rec.matchName = String(a.matchName || ""); } catch (_) {}
        try {
            var ap = a.property("ADBE Text Animator Properties");
            for (var j = 1; j <= ap.numProperties; j++) {
                var p = ap.property(j);
                var prop = { name: "", matchName: "", value: null };
                try { prop.name = String(p.name || ""); } catch (_) {}
                try { prop.matchName = String(p.matchName || ""); } catch (_) {}
                try { prop.value = p.value; } catch (_) {}
                rec.properties.push(prop);
            }
        } catch (_) {}
        try {
            var sg = a.property("ADBE Text Selectors");
            for (var k = 1; k <= sg.numProperties; k++) {
                var sel = sg.property(k);
                var srec = { name: "", matchName: "", properties: [] };
                try { srec.name = String(sel.name || ""); } catch (_) {}
                try { srec.matchName = String(sel.matchName || ""); } catch (_) {}
                try {
                    for (var m = 1; m <= sel.numProperties; m++) {
                        var sp = sel.property(m);
                        var spm = "";
                        try { spm = String(sp.matchName || ""); } catch (_) {}
                        var spRec = { name: "", matchName: spm, value: null };
                        try { spRec.name = String(sp.name || ""); } catch (_) {}
                        try { spRec.value = sp.value; } catch (_) {}
                        srec.properties.push(spRec);
                    }
                } catch (_) {}
                rec.selectors.push(srec);
            }
        } catch (_) {}
        out.push(rec);
    }
    return out;
}

// Source Text 关键帧：文本内容动画的逐帧文本（TextDocument → .text）。
// 窗口：可选 from（0-based）+ count，与 collectKeyframes 同口径。
function _readSourceTextKeyframes(sdProp, from, count) {
    var out = [];
    try {
        var n = Number(sdProp.numKeys) || 0;
        var startAt = (typeof from === "number" && isFinite(from) && from > 0) ? Math.floor(from) + 1 : 1;
        var stopAt = n;
        if (typeof count === "number" && isFinite(count) && count > 0) stopAt = startAt + Math.floor(count) - 1;
        if (stopAt > n) stopAt = n;
        for (var i = startAt; i <= stopAt; i++) {
            var rec = { time: sdProp.keyTime(i), text: "" };
            try {
                var v = sdProp.keyValue(i);
                rec.text = String(v && v.text !== undefined ? v.text : v);
            } catch (_) {}
            out.push(rec);
        }
    } catch (_) {}
    return out;
}

// 样式参数是否是组：官方三成员 PROPERTY（叶子，真机 6212）/INDEXED_GROUP（6214）/NAMED_GROUP（6213），
// 组只认后两者；常量表不可用或未命中时退到 numProperties > 0（叶子读不到可用子项数）。
function _isStyleParamGroup(prop) {
    var ptype = 0;
    try { ptype = Number(prop.propertyType); } catch (_) { ptype = 0; }
    try {
        if (ptype === PropertyType.INDEXED_GROUP || ptype === PropertyType.NAMED_GROUP) return true;
    } catch (_) { /* 常量表不可用时走下面的兜底 */ }
    try { return Number(prop.numProperties) > 0; } catch (_) { return false; }
}

// 样式参数树：递归展开子组（渐变颜色、斜面的高光/阴影等），深度上限取自 reader.maxDepth（默认 3）。
// 叶子交给 reader.readLeaf 填值/numKeys/关键帧/表达式——关键帧窗口与预算都在 _getSingleLayerDetail 里；
// 没传 reader 时只读 value。样式开关（matchName 含 /enabled 的子项）不进参数表。
// reader.nodeBudget 是整层的参数节点预算（{used, limit, capped}），耗尽即停并置 capped。
function _readLayerStyleParams(styleGroup, depth, reader, budget) {
    var params = [];
    var maxDepth = 3;
    try { if (reader && typeof reader.maxDepth === "number") maxDepth = reader.maxDepth; } catch (_) {}
    for (var i = 1; i <= styleGroup.numProperties; i++) {
        var p = null;
        try { p = styleGroup.property(i); } catch (_) {}
        if (!p) continue;
        var pm = "";
        try { pm = String(p.matchName || ""); } catch (_) {}
        if (pm.indexOf("/enabled") >= 0) continue;   // 样式开关本身不进参数表
        if (budget && budget.used >= budget.limit) { budget.capped = true; break; }
        var rec = { name: "", matchName: pm };
        try { rec.name = String(p.name || ""); } catch (_) {}
        if (_isStyleParamGroup(p)) {
            if (budget) budget.used++;
            rec.kind = "group";
            if (depth >= maxDepth) rec.depthCapped = true;
            else rec.params = _readLayerStyleParams(p, depth + 1, reader, budget);
        } else {
            if (budget) budget.used++;
            if (reader && typeof reader.readLeaf === "function") reader.readLeaf(rec, p);
            else { try { rec.value = p.value; } catch (_) { rec.value = null; } }
        }
        params.push(rec);
    }
    return params;
}

// 图层样式：列组内全部样式子组（混合选项组只提供全局光，不算样式），每条带 enabled 与 index。
// 已启用的排在前面、未启用的排在后面，同类保持子组原序——层内字节预算从尾部裁时先丢未启用条目。
// 未启用样式的参数默认不读（省略 params，置 paramsUnread）：
// includeDisabledLayerStyleParams:true 才展开。
function _readLayerStyles(layer, opts, reader) {
    var enabledStyles = [];
    var disabledStyles = [];
    var lighting = null;
    var withDisabledParams = !!(opts && opts.includeDisabledLayerStyleParams === true);
    var nodeBudget = (reader && reader.nodeBudget) ? reader.nodeBudget : null;
    var g = null;
    try { g = layer.property("ADBE Layer Styles"); } catch (_) {}
    if (!g) return { styles: [], lighting: null };
    for (var i = 1; i <= g.numProperties; i++) {
        var s = null;
        try { s = g.property(i); } catch (_) {}
        if (!s) continue;
        var mn = "";
        try { mn = String(s.matchName || ""); } catch (_) {}
        if (mn === "ADBE Blend Options Group") {
            try {
                var ga = s.property("ADBE Global Angle2");
                var gh = s.property("ADBE Global Altitude2");
                lighting = {
                    angle: ga ? ga.value : null,
                    altitude: gh ? gh.value : null
                };
            } catch (_) {}
            continue;
        }
        var enabled = false;
        // 读不到 enabled 时按未启用处理（无法区分「关闭」与「未知」，不另造标记）
        try { enabled = (s.enabled === true); } catch (_) {}
        var rec = { name: "", matchName: mn, enabled: enabled, index: i };
        try { rec.name = String(s.name || ""); } catch (_) {}
        if (enabled || withDisabledParams) {
            if (reader) reader.currentStyle = rec;
            rec.params = _readLayerStyleParams(s, 1, reader, nodeBudget);
            if (reader) reader.currentStyle = null;
        } else {
            rec.paramsUnread = true;
        }
        if (enabled) enabledStyles.push(rec);
        else disabledStyles.push(rec);
    }
    return { styles: enabledStyles.concat(disabledStyles), lighting: lighting };
}

// 单图层完整详情提取（供 getLayerInfo 和 getSelectedDetails 复用）
function _getSingleLayerDetail(layer, comp, opts) {
    opts = opts || {};
    var includeMaskVertices = opts.includeMaskVertices === true;
    var includeTextAnimators = opts.includeTextAnimators !== false;
    var includeLayerStyles = opts.includeLayerStyles !== false;
    // 形状内容树开关：默认给骨架；shapeNodeLimit 默认 200、上限 2000。
    var includeShapeContents = opts.includeShapeContents !== false;
    // 形状叶子值开关：默认只给骨架（name/matchName/kind + 组的 numProperties/children），
    // 置 true 才读叶子 value/numKeys/keyframes/expression（宿主调用与结果体积都随之上浮）。
    var includeShapeValues = opts.includeShapeValues === true;
    // 效果动画索引开关：默认 false（opt-in）。只读每个效果属性树的
    // numKeys / expression 存在性，不展开参数树；节点预算 300/层。
    var includeEffectAnimation = opts.includeEffectAnimation === true;
    // 形态口径与 _parsePaging 一致：只有 number 且有限且 >0 才接受
    //（true→1、"30"→30、0.5→0 这类旧的 Math.floor(Number(...)) 归一都去掉），
    // 正数一律至少取 1、上限 2000，其余回退默认 200。0<v<1 不得 floor 成 0（否则本层 0 节点而
    // shapeTruncated 不置位，看起来像"没有内容"）。
    var shapeNodeLimit = 200;
    if (typeof opts.shapeNodeLimit === "number" && isFinite(opts.shapeNodeLimit) && opts.shapeNodeLimit > 0) {
        shapeNodeLimit = Math.max(1, Math.floor(opts.shapeNodeLimit));
    }
    if (shapeNodeLimit > 2000) shapeNodeLimit = 2000;
    // ── 关键帧窗口 + 响应级字节预算──────────
    // 真机实测：关键帧明细整份返回时 100 键 28,088 字符、120 键 33,593、3000 键
    // 821,742（3000 键蒙版 304,995），默认参数即可越过 agent 管线 32K 截断线；截断后的 JSON
    // 解析失败，模型拿到的是坏文本。现在四件事：
    //   ① 每个属性一页窗口：keyframeOffset（0-based，默认 0）+ keyframeLimit（默认 30、上限
    //      200，number 且有限且 >0 才接受，正数至少 1，其余回退默认）；
    //   ② 另加 keyframeOffsets 对象（{position:30, scale:21}，键也接受
    //      matchName），逐个属性取 offset；未点名的属性仍用 keyframeOffset 标量。逐属性预算
    //      收缩时 position 30 条/scale 21 条可以各自续页，不会整套窗口一起丢或重读；
    //   ③ 所有 layer 路径的关键帧数组（transform 六属性 / 蒙版四属性含 Mask Path / timeRemap /
    //      timeMap / Source Text / shapeContents 叶子）统一走 _kfTrim 计费，除原数组外给
    //      Total/Offset/Limit/HasMore/Truncated（0 条时另给 Dropped）；
    //   ④ 响应级关键帧字节预算 LAYER_KEYFRAME_BYTE_BUDGET=12000（按 JSON.stringify(keyframes)
    //      .length 累计，同一响应内多层共用一份预算）：剩余额度装不下下一条就停（可为 0 条），
    //      置该属性 Truncated/Dropped 与层级 keyframesBudgetExhausted，保证关键帧总字节 ≤12KB。
    // 续页：该属性 HasMore=true 时用 keyframeOffsets[该属性前缀] = 该属性的 Offset + 实际条数。
    var LAYER_KEYFRAME_BYTE_BUDGET = 12000;
    // 形状内容树的响应级字节预算：节点数预算（shapeNodeLimit）只管条数——
    // 实测单层 200 节点约 12KB，layerLimit=5 默认就能到 60KB；单层 2000 节点 113KB。
    // 这里按已生成 shapeContents 的 JSON 长度累计，装不下就把节点数预算按剩余额度收缩重建，
    // 仍装不下才整份丢弃，置 shapeBytesTruncated（与 shapeTruncated 并存）。
    var SHAPE_BYTE_BUDGET = 12000;
    // 形状叶子关键帧的单叶字节上限：整棵树已在 SHAPE_BYTE_BUDGET 里计费，
    // 叶子键不再进关键帧预算；单叶给 2000B（约 30 条键），装不下按剩余预算等比收缩。
    var SHAPE_LEAF_KF_BYTES = 2000;
    // 响应级总预算：上面三份 12KB 互不相加，单层密集数据默认 33,042B、
    // 默认 layerType=shape（layerLimit=5）47,074B，越过 agent 管线 32K。这里再加一份 24000
    // 的总预算：关键帧、形状树、蒙版/效果条目、蒙版顶点都从同一个 respUsed 扣；扣费顺序固定为
    // 关键帧 → 形状 → 载荷（后扣的被先饿死，等价于总预算耗尽时按「载荷 → 形状 → 关键帧」
    // 收缩），各分项 12KB 仍独立生效，三个分项标记语义不变。
    // 固定字段（base/transform 静态值等）不计入 24000；结果组装时再按 JSON 长度兜底
    //（RESPONSE_JSON_LIMIT=26000，给 result 包装与截断标记留余量），保证最终 JSON ≤约 28KB。
    var RESPONSE_BYTE_BUDGET = 24000;
    var RESPONSE_JSON_LIMIT = 26000;
    var _kfOffset = 0;
    if (typeof opts.keyframeOffset === "number" && isFinite(opts.keyframeOffset) && opts.keyframeOffset > 0) {
        _kfOffset = Math.floor(opts.keyframeOffset);
    }
    // 逐属性 offset（键大小写不敏感 + 未知键回显）：键先按输出
    // 字段前缀做大小写不敏感匹配（position/scale/rotation/opacity/anchorPoint/audioLevels/
    // timeRemap/sourceText/maskPath/maskOpacity/maskFeather/maskExpansion/shapeContents/layerStyle），
    // 其次按属性 matchName 精确匹配；两者都不命中的键（如 positionKeyframes 这种带后缀写法）
    // 收集到结果级 keyframeOffsetsIgnored，不静默忽略。值须为 number 且 ≥0，否则忽略（回退标量）。
    var _KF_OFFSET_PREFIXES = ["position", "scale", "rotation", "opacity", "anchorPoint",
        "audioLevels", "timeRemap", "sourceText", "maskPath", "maskOpacity", "maskFeather",
        "maskExpansion", "shapeContents", "layerStyle"];
    function _kfPrefixKey(key) {
        var lk = String(key).toLowerCase();
        for (var pi = 0; pi < _KF_OFFSET_PREFIXES.length; pi++) {
            if (_KF_OFFSET_PREFIXES[pi].toLowerCase() === lk) return _KF_OFFSET_PREFIXES[pi];
        }
        return "";
    }
    var _kfOffsets = null;
    var _kfOtherKeys = [];        // 非前缀键（可能是 matchName），末尾按"是否真被消费"判定未知
    var _kfUsedMatchNames = {};   // 真正命中某属性 matchName 的键（命中即算已识别）
    if (opts.keyframeOffsets && typeof opts.keyframeOffsets === "object") {
        _kfOffsets = {};
        for (var _koKey in opts.keyframeOffsets) {
            if (!Object.prototype.hasOwnProperty.call(opts.keyframeOffsets, _koKey)) continue;
            var _koName = String(_koKey);
            var _koVal = opts.keyframeOffsets[_koKey];
            var _koOk = (typeof _koVal === "number" && isFinite(_koVal) && _koVal >= 0);
            var _koCanon = _kfPrefixKey(_koName);
            if (_koCanon) {
                if (_koOk) _kfOffsets[_koCanon] = Math.floor(_koVal);
                continue;
            }
            _kfOtherKeys.push(_koName);
            if (_koOk) _kfOffsets[_koName] = Math.floor(_koVal);
        }
    }
    var _kfLimit = 30;
    if (typeof opts.keyframeLimit === "number" && isFinite(opts.keyframeLimit) && opts.keyframeLimit > 0) {
        _kfLimit = Math.max(1, Math.floor(opts.keyframeLimit));
    }
    if (_kfLimit > 200) _kfLimit = 200;
    // 预算体由调用方按**响应**建好传进来（同页多层共用）；直接调用时本层独占一份
    var _kfBudget = (opts._responseBudget && typeof opts._responseBudget === "object")
        ? opts._responseBudget
        : { kfUsed: 0, shapeUsed: 0, payloadUsed: 0, kfExhausted: false, shapeExhausted: false };
    if (typeof _kfBudget.kfUsed !== "number") _kfBudget.kfUsed = 0;
    if (typeof _kfBudget.shapeUsed !== "number") _kfBudget.shapeUsed = 0;
    if (typeof _kfBudget.payloadUsed !== "number") _kfBudget.payloadUsed = 0;
    if (typeof _kfBudget.respUsed !== "number") _kfBudget.respUsed = 0;
    var _kfLayerHit = false;      // 本层是否被关键帧字节预算截过（层级标记用）
    var _shapeLayerHit = false;   // 本层是否被形状字节预算截过（层级标记用）
    var _respLayerHit = false;    // 本层是否被响应级总预算截过（层级标记用）
    // ── masks/effects 清单：分页窗口 + 响应级载荷预算─────────
    // 真机：单层 300 蒙版 61,493B、5 层×50 蒙版 53,602B、5 层×100 效果 36,822B——两块清单若按
    // numProperties 全量输出（蒙版条目含 Mask Path 形态与三条子属性关键帧，单条可达 200B+）。
    // 现在两件事：
    //   ① 各自一页窗口（口径同 _parsePaging）：maskOffset/maskLimit 与 effectOffset/effectLimit
    //      默认 0/20、上限 100；每层另给 masksTotal/Offset/Limit/HasMore/nextMaskOffset（effects 同名）；
    //   ② 响应级载荷预算 LAYER_PAYLOAD_BYTE_BUDGET=12000（与关键帧 12KB、形状 12KB 分开计）：
    //      按条目 JSON 长度累计，同页多层共用一份，剩余额度装不下下一条就停，置该层
    //      masksTruncated/effectsTruncated 与 payloadBytesTruncated，保证基础载荷 ≤12KB。
    //      条目字节同时从响应级总预算 respUsed 扣（见上）。
    // 续页：masksHasMore=true 时下一层用 nextMaskOffset 当 maskOffset（每响应重置预算）。
    var LAYER_PAYLOAD_BYTE_BUDGET = 12000;
    var _payloadLayerHit = false;   // 本层是否被载荷预算截过（层级标记用）
    // 剩余响应额度（所有分项都从同一份 respUsed 扣；可能为 0 或负，
    // 调用方自行 clamp）
    function _respRemain() {
        return RESPONSE_BYTE_BUDGET - _kfBudget.respUsed;
    }
    // 响应级计费：条目被接受后才累计，累计后 clamp 到 24000。否则
    // _kfTrim 在拒绝/空页时仍把 "[]" 的 2B 计入 respUsed（每个属性一份），dense 场景实测
    // respUsed 24,039——24000 软上限被这些基数顶过。这里统一走 clamp，账面永不超 24000。
    function _respCharge(bytes) {
        var b = (typeof bytes === "number" && isFinite(bytes) && bytes > 0) ? bytes : 0;
        if (b > 0) _kfBudget.respUsed += b;
        if (_kfBudget.respUsed > RESPONSE_BYTE_BUDGET) _kfBudget.respUsed = RESPONSE_BYTE_BUDGET;
    }
    // 条目计费字节 = 整条 JSON − 已单独计费的数组（*Keyframes 走关键帧预算；vertices 仍从
    // 载荷预算豁免，但按实际 JSON 长度单独计入响应级总预算——20 蒙版×200 顶点
    // 合计 41,281B，由 respUsed 封顶，装不下从尾部裁顶点数组）。
    // 不重复计费，否则一条 200 键蒙版或 2000 顶点蒙版会被两套预算各扣一次、整条丢弃
    //（vertexLimit:2000 就永远拿不到）。
    function _sumExemptBytes(o, depth) {
        if (!o || typeof o !== "object" || depth > 8) return 0;
        var sum = 0;
        for (var k in o) {
            if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
            var v = o[k];
            if (!v || typeof v !== "object") continue;
            if ((/(Keyframes)$/.test(k) || k === "keyframes" || k === "vertices") && _isArrayValue(v)) {
                try { sum += JSON.stringify(v).length; } catch (_) {}
                continue;
            }
            sum += _sumExemptBytes(v, depth + 1);
        }
        return sum;
    }
    function _payloadEntryBytes(rec) {
        var total = 0;
        try { total = JSON.stringify(rec).length; } catch (_) { return 0; }
        var exempt = 0;
        try { exempt = _sumExemptBytes(rec, 0); } catch (_) { exempt = 0; }
        total -= exempt;
        return total > 0 ? total : 0;
    }
    // 条目计费：bytes 含该条 JSON 与分隔符；分项载荷预算与响应级总预算都装得下才返回 true。
    // 响应级装不下同样停止（不向总预算透支）。
    function _payloadCharge(bytes) {
        var payloadBlocked = (_kfBudget.payloadUsed + bytes > LAYER_PAYLOAD_BYTE_BUDGET);
        var respBlocked = (_kfBudget.respUsed + bytes > RESPONSE_BYTE_BUDGET);
        if (payloadBlocked || respBlocked) {
            if (payloadBlocked) {
                _payloadLayerHit = true;
                _kfBudget.payloadExhausted = true;
            }
            if (respBlocked) {
                _respLayerHit = true;
                _kfBudget.respExhausted = true;
            }
            return false;
        }
        _kfBudget.payloadUsed += bytes;
        _respCharge(bytes);
        return true;
    }
    // 字节收缩：list/offset/limit 已按窗口切好，这里只按剩余预算决定能留下几条。
    // 返回 { list, total, offset, limit, hasMore, truncated, dropped }；hasMore/truncated 按
    // **实际返回条数**重算（预算收缩后仍要能续页，不能按参数窗口谎报）。
    // 分项 12KB 与响应级 24000 两道门都必须过；任一挡住都停止并同步该属性的
    // Truncated/Dropped。只有关键帧 12KB 真撞到才置层级 keyframesBudgetExhausted，
    // 总预算挡下的收缩只置 responseBytesTruncated。
    function _kfTrim(list, total, offset, limit) {
        var kept = [];
        var bytes = 2;                       // "[]" 自身
        var blocked = false;
        var kfGateHit = false;               // 12KB 关键帧预算真的被撞到
        for (var i = 0; i < list.length; i++) {
            var ib = 0;
            try { ib = JSON.stringify(list[i]).length; } catch (_) { ib = 0; }
            var add = ib + (kept.length > 0 ? 1 : 0);
            if (_kfBudget.kfUsed + bytes + add > LAYER_KEYFRAME_BYTE_BUDGET) {
                kfGateHit = true;
                blocked = true;
                break;
            }
            if (_kfBudget.respUsed + bytes + add > RESPONSE_BYTE_BUDGET) {
                _kfBudget.respExhausted = true;
                _respLayerHit = true;
                blocked = true;
                break;
            }
            kept.push(list[i]);
            bytes += add;
        }
        _kfBudget.kfUsed += bytes;
        _respCharge(bytes);
        // 分项标记只表示关键帧 12KB 真被撞到；由总预算挡下的收缩只置
        // responseBytesTruncated（_respLayerHit），不再把 keyframesBudgetExhausted 当兜底标记用。
        if (kfGateHit) {
            _kfLayerHit = true;
            _kfBudget.kfExhausted = true;
        }
        return {
            list: kept, total: total, offset: offset, limit: limit,
            hasMore: (offset + kept.length) < total,
            truncated: (offset > 0 || kept.length < total),
            dropped: (blocked && kept.length === 0)
        };
    }
    // 平铺属性输出：原 *Keyframes 数组 + 窗口元数据（小数据下数组内容与旧行为一致）
    function _kfEmit(obj, key, st) {
        obj[key] = st.list;
        obj[key + "Total"] = st.total;
        obj[key + "Offset"] = st.offset;
        obj[key + "Limit"] = st.limit;
        obj[key + "HasMore"] = st.hasMore;
        if (st.truncated) obj[key + "Truncated"] = true;
        if (st.dropped) obj[key + "Dropped"] = true;
    }
    // 逐属性 offset 查找：输出字段前缀优先（positionKeyframes → position），
    // 其次该属性的 matchName；都未点名则回退 keyframeOffset 标量（旧行为不变）。
    function _kfOffsetFor(prefix, prop) {
        var key = String(prefix || "");
        if (/(Keyframes)$/.test(key)) key = key.substring(0, key.length - 9);
        if (key === "keyframes") key = "timeRemap";   // timeRemap 块内的无前缀数组
        if (_kfOffsets) {
            if (typeof _kfOffsets[key] === "number") return _kfOffsets[key];
            var mn = "";
            try { mn = String(prop && prop.matchName ? prop.matchName : ""); } catch (_) { mn = ""; }
            if (mn && typeof _kfOffsets[mn] === "number") {
                _kfUsedMatchNames[mn] = true;
                return _kfOffsets[mn];
            }
        }
        return _kfOffset;
    }
    // 组合：按属性取窗口 → 计费 → 输出。属性不可读时不产出字段（旧行为：字段省略）
    // offsetPrefix：逐属性起点的查表键（缺省 = 输出字段名）。图层样式的叶子传 "layerStyle"——
    // 它们的输出字段名是 keyframes，会被 _kfOffsetFor 误当成 timeRemap 块的无前缀数组。
    function _kfApply(obj, key, prop, offsetPrefix) {
        var total = 0;
        try { total = Number(prop.numKeys) || 0; } catch (_) { total = 0; }
        var off = _kfOffsetFor(offsetPrefix || key, prop);
        if (off > total) off = total;
        var list = [];
        try { list = collectKeyframes(prop, off, _kfLimit); } catch (_) { list = []; }
        _kfEmit(obj, key, _kfTrim(list, total, off, _kfLimit));
    }
    // 表达式截断：单个 40,000 字符的 Position 表达式让默认 layer
    // 详情到 40,988B（transform 六属性与 Source Text 各一份，互不共享预算）。与 target=effect
    // 同口径：超 800 字符只给前 800，另给 <key>Truncated / <key>Length（原文仍在 AE 里，
    // 需要时可再查）。字段名带属性前缀（positionExpressionTruncated / sourceTextExpressionLength），
    // 同一层多个表达式不互相覆盖；≤800 字符时不产生额外字段（旧行为不变）。
    var EXPR_SHOW_LIMIT = 800;
    // 表达式兜底上限：块内只截到 800 字符，多层同页仍可越线（6 表达式/层×
    // 800 字符 + 默认 layerLimit=5 实测 28,744B；3/层 + layerLimit=10 37,689B）。结果组装时对
    // 仍超长的表达式统一截到 200（见 _enforceResponse ⓪-c），Length 记原文真实长度。
    var EXPR_FALLBACK_LIMIT = 200;
    function _exprEmit(obj, key, prop) {
        var full = "";
        try { full = (prop && prop.expression) ? String(prop.expression) : ""; } catch (_) { full = ""; }
        if (full.length > EXPR_SHOW_LIMIT) {
            obj[key] = full.substring(0, EXPR_SHOW_LIMIT);
            obj[key + "Truncated"] = true;
            obj[key + "Length"] = full.length;
        } else {
            obj[key] = full;
        }
        // 表达式字节计入响应级 24000 总预算。计的是**实际输出**长度（超 800 时
        // 只算 800）；空串不计费，无表达式的薄数据体积与旧行为一致。三处调用方（transform 六属性 /
        // timeRemap / sourceTextExpression）共用这一处计费。
        if (full.length > 0) _respCharge(full.length > EXPR_SHOW_LIMIT ? EXPR_SHOW_LIMIT : full.length);
    }
    // ── 文本块响应上限 ──────────────────────────────────────────────────────────
    // 真机/体积实测：queryDetails 的 text（Source Text 当前文本）与 textAnimators 不设上限时，
    // 既不进 24000 总预算、也不走 _enforceResponse，默认返回且无任何截断字段——5 文本层×10 动画器
    // （878B/个）49,084B、5×20 93,084B、10 层×20,000 字符文本 209,522B、单层 100,000 字符
    // 101,084B，均越过管线 32K，与「结果组装兜底、最终 ≤约 28KB」的契约矛盾。这里补两道：
    //   ① 当前文本 TEXT_SHOW_LIMIT=2000：超出只给前 2000 + textTruncated + textLength（真实长度）；
    //      ≤2000 不产生额外字段（旧行为不变）。
    //   ② 动画器 TEXT_ANIMATOR_BYTE_BUDGET=6000：条数窗口（textAnimatorOffset/textAnimatorLimit）
    //      之外再按条目 JSON 长度从尾部裁，置 textAnimatorsBytesTruncated；单条自身超 6000B 时
    //      按本次响应剩余额度退让一条（够则把上限抬到该条大小）；两者都纳入
    //      _enforceResponse 兜底（先裁动画器，再裁图层样式，再截文本，最后才走载荷→形状→关键帧）。
    //   ③ 图层样式 LAYER_STYLE_BYTE_BUDGET=6000（与 ② 同类）：layerStyles 若按
    //      numProperties 全量返回且无任何上限；现在按条目 JSON 长度累计、从尾部裁，输出
    //      layerStylesTotal/layerStylesTruncated，字节裁断另置 layerStylesBytesTruncated。
    //   ④ ②/③ 的字节都计入响应级 respUsed（动画器字节未计入时多层只能靠兜底）。
    var TEXT_SHOW_LIMIT = 2000;
    var TEXT_ANIMATOR_BYTE_BUDGET = 6000;
    var LAYER_STYLE_BYTE_BUDGET = 6000;
    // 样式参数节点预算（整层）：渐变类样式每个色标占一组，叶子可能很多，超过即停并置
    // layerStylesNodeCapped（不静默丢，调用方据 fields:['layerStyles'] 单层复查）。
    var LAYER_STYLE_NODE_LIMIT = 500;
    // ── 蒙版顶点计费 ──────────────────────────────────────────────────────────
    // vertices 仍从载荷条目字节里豁免（否则一条 vertexLimit:2000 的蒙版会被整条丢弃），但按
    // 实际 JSON 单独计入响应级 respUsed；额度不足时从尾部裁顶点数组（置 verticesTruncated），
    // 跨蒙版因此有总量上限。以下 helper 都是函数内局部声明（不新增顶层声明）。
    function _collectVertexArrays(o, acc, depth) {
        if (!o || typeof o !== "object" || depth > 8) return acc;
        for (var k in o) {
            if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
            var v = o[k];
            if (!v || typeof v !== "object") continue;
            if (k === "vertices" && _isArrayValue(v)) { acc.push({ owner: o, key: k, arr: v }); continue; }
            if (_isArrayValue(v)) {
                for (var i = 0; i < v.length; i++) _collectVertexArrays(v[i], acc, depth + 1);
                continue;
            }
            _collectVertexArrays(v, acc, depth + 1);
        }
        return acc;
    }
    function _vertexBytesOf(rec) {
        var arrs = _collectVertexArrays(rec, [], 0);
        var sum = 0;
        for (var i = 0; i < arrs.length; i++) {
            try { sum += JSON.stringify(arrs[i].arr).length; } catch (_) {}
        }
        return sum;
    }
    // 裁到总字节 ≤ allow：前面的数组整段保留，第一个装不下的按顶点保留前缀（至少 0 个），
    // 之后的数组清空；被裁的数组所属对象置 verticesTruncated。返回裁后实际字节。
    function _trimVerticesToBudget(rec, allow) {
        var arrs = _collectVertexArrays(rec, [], 0);
        if (arrs.length === 0) return 0;
        var total = 0;
        var i;
        for (i = 0; i < arrs.length; i++) { try { total += JSON.stringify(arrs[i].arr).length; } catch (_) {} }
        if (total <= allow) return total;
        if (allow < 0) allow = 0;
        var used = 0;
        var trimmedFrom = -1;
        for (i = 0; i < arrs.length; i++) {
            var a = arrs[i].arr;
            var b = 0;
            try { b = JSON.stringify(a).length; } catch (_) { b = 0; }
            var remain = allow - used;
            if (remain >= b) { used += b; continue; }
            var keep = 0;
            var acc = 2;                 // "[]" 自身
            for (var vi = 0; vi < a.length; vi++) {
                var vb = 0;
                try { vb = JSON.stringify(a[vi]).length; } catch (_) { vb = 0; }
                var add = vb + (keep > 0 ? 1 : 0);
                if (acc + add > remain) break;
                acc += add;
                keep++;
            }
            if (keep < a.length) {
                a.length = keep;
                arrs[i].owner[arrs[i].key + "Truncated"] = true;   // verticesTruncated
                used += acc;
                trimmedFrom = i;
                break;
            }
        }
        if (trimmedFrom >= 0) {
            for (var j = trimmedFrom + 1; j < arrs.length; j++) {
                if (arrs[j].arr.length > 0) {
                    arrs[j].arr.length = 0;
                    arrs[j].owner[arrs[j].key + "Truncated"] = true;
                }
            }
        }
        var actual = 0;
        for (i = 0; i < arrs.length; i++) { try { actual += JSON.stringify(arrs[i].arr).length; } catch (_) {} }
        return actual;
    }
    // ── 结果组装级兜底 ─────────────────────────────────────────────────────────
    // 固定字段（base/transform 静态值、text 等）不逐字节计入 24000（layerStyles 的条目字节
    // 按实际 JSON 计入）；多层同页时结果仍可能越过 28KB。这里按 JSON 长度兜底，收缩顺序固定为
    // 载荷 → 形状 → 关键帧（与 emission 的优先级一致）：只裁到刚好过线，真被收缩的层置
    // responseBytesTruncated，并同步续页/分项标记。返回是否发生收缩。
    function _collectKfRefs(o, acc, depth) {
        if (!o || typeof o !== "object" || depth > 10) return acc;
        for (var k in o) {
            if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
            var v = o[k];
            if (!v || typeof v !== "object") continue;
            if ((/(Keyframes)$/.test(k) || k === "keyframes") && _isArrayValue(v)) {
                acc.push({ owner: o, key: k, arr: v });
                continue;
            }
            if (_isArrayValue(v)) {
                for (var i = 0; i < v.length; i++) _collectKfRefs(v[i], acc, depth + 1);
                continue;
            }
            _collectKfRefs(v, acc, depth + 1);
        }
        return acc;
    }
    // 从最后一层起裁一条关键帧（尾巴优先），同步该属性的 HasMore/Truncated/Dropped
    function _popOneKeyframe(layer) {
        var refs = _collectKfRefs(layer, [], 0);
        for (var i = refs.length - 1; i >= 0; i--) {
            if (refs[i].arr.length > 0) {
                refs[i].arr.pop();
                var owner = refs[i].owner;
                var key = refs[i].key;
                var total = 0;
                var offset = 0;
                try { total = Number(owner[key + "Total"]) || 0; } catch (_) { total = 0; }
                try { offset = Number(owner[key + "Offset"]) || 0; } catch (_) { offset = 0; }
                owner[key + "HasMore"] = (offset + refs[i].arr.length) < total;
                if (offset > 0 || refs[i].arr.length < total) owner[key + "Truncated"] = true;
                if (refs[i].arr.length === 0 && total > 0) owner[key + "Dropped"] = true;
                return true;
            }
        }
        return false;
    }
    // 形状树：递删最靠后的子节点（组骨架保留；顶层至少留 1 个节点）
    function _countShapeNodes(nodes) {
        if (!_isArrayValue(nodes)) return 0;
        var n = nodes.length;
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i] && _isArrayValue(nodes[i].children)) n += _countShapeNodes(nodes[i].children);
        }
        return n;
    }
    function _trimShapeOneNode(nodes) {
        if (!_isArrayValue(nodes) || nodes.length === 0) return false;
        for (var i = nodes.length - 1; i >= 0; i--) {
            var node = nodes[i];
            if (node && _isArrayValue(node.children) && node.children.length > 0) {
                if (_trimShapeOneNode(node.children)) return true;
            }
        }
        if (nodes.length > 1) { nodes.pop(); return true; }
        return false;
    }
    function _enforceResponse(layers, extraBytes) {
        if (!_isArrayValue(layers)) return false;
        var extra = (typeof extraBytes === "number" && extraBytes > 0) ? extraBytes : 400;
        function _over() {
            try { return (JSON.stringify(layers).length + extra) > RESPONSE_JSON_LIMIT; } catch (_) { return false; }
        }
        if (!_over()) return false;
        var hit = false;
        var i;
        // ⓪ 文本块：固定收缩顺序 textAnimators → layerStyles → text，之后才走
        // 既有 载荷 → 形状 → 关键帧。固定块优先收缩是因为它们的信息密度最低（同层动画器/图层样式/
        // 长文本可另用单层查询或 fields 收窄复读）。三趟分开写以保证顺序是全局的：前一趟裁完所有层
        // 才进入下一趟（按层混在同一循环里时，后面的样式会先于前面层的文本被裁）。
        for (i = layers.length - 1; i >= 0 && _over(); i--) {
            var tl = layers[i];
            if (!tl || typeof tl !== "object") continue;
            var _taPopped = false;
            while (_over() && _isArrayValue(tl.textAnimators) && tl.textAnimators.length > 0) {
                tl.textAnimators.pop();
                var _taBase = 0;
                try { _taBase = Number(tl.textAnimatorsOffset) || 0; } catch (_) { _taBase = 0; }
                var _taTotal = 0;
                try { _taTotal = Number(tl.textAnimatorsTotal) || 0; } catch (_) { _taTotal = 0; }
                tl.nextTextAnimatorOffset = _taBase + tl.textAnimators.length;
                tl.textAnimatorsHasMore = tl.nextTextAnimatorOffset < _taTotal;
                tl.textAnimatorsTruncated = true;
                tl.textAnimatorsBytesTruncated = true;
                tl.responseBytesTruncated = true;
                hit = true;
                _taPopped = true;
            }
            // 兜底把本页动画器裁空且组里本来有条目 → textAnimatorsStarved。HasMore 置 false：
            // 否则 nextTextAnimatorOffset 停在本次起点，调用方按它重试会逐字节拿到同一份 0 条结果
            //（与 masks/effects 同族）。替代路径是 fields:['textAnimators'] 或单层查询。
            if (_taPopped && tl.textAnimators.length === 0 && _taTotal > 0) {
                tl.textAnimatorsStarved = true;
                tl.textAnimatorsHasMore = false;
                tl.textAnimatorsHint = "本页剩余额度不足，动画器已被兜底裁掉；改用 fields:['textAnimators'] 或单层查询";
            }
        }
        // 图层样式没有分页窗口（层内 6000B 已先裁过一轮），兜底只从尾部丢条目；续读改用
        // fields:['layerStyles'] 单层查询。
        for (i = layers.length - 1; i >= 0 && _over(); i--) {
            var lsl = layers[i];
            if (!lsl || typeof lsl !== "object") continue;
            while (_over() && _isArrayValue(lsl.layerStyles) && lsl.layerStyles.length > 0) {
                lsl.layerStyles.pop();
                lsl.layerStylesTruncated = true;
                lsl.responseBytesTruncated = true;
                hit = true;
            }
        }
        for (i = layers.length - 1; i >= 0 && _over(); i--) {
            var tx = layers[i];
            if (!tx || typeof tx !== "object") continue;
            if (typeof tx.text === "string" && tx.text.length > TEXT_SHOW_LIMIT) {
                var _textFull = tx.text.length;
                // 已被块内截过时 textLength 保的是原文真实长度，兜底不要再改小
                try {
                    if (typeof tx.textLength === "number" && tx.textLength > _textFull) _textFull = tx.textLength;
                } catch (_) {}
                tx.text = tx.text.substring(0, TEXT_SHOW_LIMIT);
                tx.textTruncated = true;
                tx.textLength = _textFull;
                tx.responseBytesTruncated = true;
                hit = true;
            }
        }
        // 文本第二轮：块内截到 2000 后，多层同页仍可能超线（10 层×2000 字符
        // 正文约 20KB + 包装）；从最后一层起按半量继续收缩（下限 200，保留 textTruncated/
        // textLength = 原文真实长度），再不够才进入下面的载荷/形状/关键帧收缩。
        var _textPass = 0;
        while (_over() && _textPass < 12) {
            _textPass++;
            var _textShrunk = false;
            for (i = layers.length - 1; i >= 0 && _over(); i--) {
                var t2 = layers[i];
                if (!t2 || typeof t2.text !== "string" || t2.text.length === 0) continue;
                var _nextTextLen = Math.floor(t2.text.length / 2);
                if (_nextTextLen < 200) _nextTextLen = 200;
                if (_nextTextLen >= t2.text.length) continue;
                var _textOrig = t2.text.length;
                try {
                    if (typeof t2.textLength === "number" && t2.textLength > _textOrig) _textOrig = t2.textLength;
                } catch (_) {}
                t2.text = t2.text.substring(0, _nextTextLen);
                t2.textTruncated = true;
                t2.textLength = _textOrig;
                t2.responseBytesTruncated = true;
                hit = true;
                _textShrunk = true;
                if (!_over()) break;
            }
            if (!_textShrunk) break;
        }
        // ⓪-b 效果动画索引：effectAnimation 的字节若不计入 respUsed、也不在任何
        // 收缩趟里——5 层×100 效果 + includeEffectAnimation 实测 35,505B，兜底只能裁 effects
        //（早已被载荷预算裁空）→ 裁不动。这里从尾部按效果条目裁，置 effectAnimationTruncated；
        // 仍超线才进 ① 载荷继续裁 effects。
        for (i = layers.length - 1; i >= 0 && _over(); i--) {
            var fal = layers[i];
            if (!fal || typeof fal !== "object" || !_isArrayValue(fal.effectAnimation)) continue;
            while (_over() && fal.effectAnimation.length > 0) {
                fal.effectAnimation.pop();
                fal.effectAnimationTruncated = true;
                fal.responseBytesTruncated = true;
                hit = true;
            }
        }
        // ⓪-c 表达式：块内只截到 800 字符（_exprEmit），多层同页仍可越线。
        // 这里对仍超长的表达式统一截到 EXPR_FALLBACK_LIMIT=200，字段名沿用属性前缀
        //（positionExpressionTruncated / positionExpressionLength；timeRemap 与 timeMap 这两个
        // 嵌套对象内的 expressionTruncated/expressionLength 同口径），Length 记原文真实长度。
        // 覆盖三处：transform 六属性 / timeRemap（+ timeMap）/ sourceTextExpression。shapeContents
        // 叶子的 expression（500 上限、只给 Truncated 不给 Length）不在这一趟里。
        function _layerExprRefs(el) {
            var refs = [];
            for (var ek in el) {
                if (!Object.prototype.hasOwnProperty.call(el, ek)) continue;
                if (!/Expression$/.test(ek)) continue;
                if (typeof el[ek] !== "string") continue;
                refs.push({ owner: el, key: ek });
            }
            var _tmRef = el.timeRemap;
            if (_tmRef && typeof _tmRef === "object" && typeof _tmRef.expression === "string") {
                refs.push({ owner: _tmRef, key: "expression" });
            }
            var _tmMapRef = el.timeMap;
            if (_tmMapRef && typeof _tmMapRef === "object" && typeof _tmMapRef.expression === "string") {
                refs.push({ owner: _tmMapRef, key: "expression" });
            }
            return refs;
        }
        for (i = layers.length - 1; i >= 0 && _over(); i--) {
            var exl = layers[i];
            if (!exl || typeof exl !== "object") continue;
            var _exprRefs = _layerExprRefs(exl);
            var _exprHit = false;
            for (var ei = 0; ei < _exprRefs.length && _over(); ei++) {
                var _er = _exprRefs[ei];
                var _es = _er.owner[_er.key];
                if (typeof _es !== "string" || _es.length <= EXPR_FALLBACK_LIMIT) continue;
                var _esFull = _es.length;
                try {
                    var _esPrev = Number(_er.owner[_er.key + "Length"]);
                    if (_esPrev > _esFull) _esFull = _esPrev;
                } catch (_) {}
                _er.owner[_er.key] = _es.substring(0, EXPR_FALLBACK_LIMIT);
                _er.owner[_er.key + "Truncated"] = true;
                _er.owner[_er.key + "Length"] = _esFull;
                _exprHit = true;
                hit = true;
            }
            if (_exprHit) exl.responseBytesTruncated = true;
        }
        // ① 载荷：从最后一层起逐条丢尾部条目（续页偏移同步，调用方可改用单层查询继续）
        for (i = layers.length - 1; i >= 0 && _over(); i--) {
            var pl = layers[i];
            if (!pl || typeof pl !== "object") continue;
            while (_over()) {
                var arrKey = "";
                if (_isArrayValue(pl.effects) && pl.effects.length > 0) arrKey = "effects";
                else if (_isArrayValue(pl.masks) && pl.masks.length > 0) arrKey = "masks";
                else break;
                var arr = pl[arrKey];
                arr.pop();
                var isFx = (arrKey === "effects");
                var base = 0;
                try { base = Number(pl[isFx ? "effectsOffset" : "masksOffset"]) || 0; } catch (_) { base = 0; }
                var total = 0;
                try { total = Number(pl[isFx ? "effectsTotal" : "masksTotal"]) || 0; } catch (_) { total = 0; }
                pl[isFx ? "nextEffectOffset" : "nextMaskOffset"] = base + arr.length;
                pl[isFx ? "effectsHasMore" : "masksHasMore"] = (base + arr.length) < total;
                pl[isFx ? "effectsTruncated" : "masksTruncated"] = true;
                // 兜底把本页裁空且组里本来有条目 → starved。hasMore 置 false，
                // 不再给出「按 next 重试同一查询就能取到」的假续页；调用方看 starved 改用
                // fields:['masks']/['effects'] 或单层查询。
                if (arr.length === 0 && total > 0) {
                    if (isFx) {
                        pl.effectsStarved = true;
                        pl.effectsHasMore = false;
                        pl.effectsHint = "本页额度被关键帧/形状/动画器/样式占满；改用 fields:['effects'] 或单层查询";
                    } else {
                        pl.masksStarved = true;
                        pl.masksHasMore = false;
                        pl.masksHint = "本页额度被关键帧/形状/动画器/样式占满；改用 fields:['masks'] 或单层查询";
                    }
                }
                // 兜底只置响应级标记，不污染分项标记——payloadBytesTruncated
                // 只表示 12KB 载荷预算真的被撞到（由 _payloadCharge 置位），这里不再赋值。
                pl.responseBytesTruncated = true;
                hit = true;
            }
        }
        // ①-b references：references 对同 comp 各层是**同一个数组实例**，JSON 按层
        // 重复输出——5 层×60 引用 33,951B、5 层×200 引用 94,596B。构建期虽按层把字节计入 respUsed
        // 并置了 responseBytesTruncated，兜底却没有 references 趟，结果裁不动（越过 32K 管线）。
        // 这里按层从数组尾部裁；先 slice 浅拷贝再 pop——共享实例就地裁剪会连带改掉其它层
        //（按层独立处理）。referencesTotal 无既有值时补本次返回前的条数（源侧 200 上限命中时即该
        // 上限，referencesTruncated 表示仍有未返回的引用），并同步层/结果级 responseBytesTruncated。
        for (i = layers.length - 1; i >= 0 && _over(); i--) {
            var rfl = layers[i];
            if (!rfl || typeof rfl !== "object") continue;
            if (!_isArrayValue(rfl.references) || rfl.references.length === 0) continue;
            var _refTotalKeep = rfl.references.length;
            try {
                if (typeof rfl.referencesTotal === "number" && rfl.referencesTotal > _refTotalKeep) {
                    _refTotalKeep = rfl.referencesTotal;
                }
            } catch (_) { }
            rfl.references = rfl.references.slice();
            while (_over() && rfl.references.length > 0) {
                rfl.references.pop();
                rfl.referencesTruncated = true;
                rfl.responseBytesTruncated = true;
                hit = true;
            }
            if (rfl.referencesTruncated === true) rfl.referencesTotal = _refTotalKeep;
        }
        // ①-c markers：构建期只按 respRemain 从尾部裁（24000 不含每层固定字段），
        // 5 层×100 标记 + 常规 transform 块 32,143B 仍越 28KB，而兜底没有 markers 趟（裁到最后只剩
        // 关键帧/形状，可能都是空）。这里按层从尾部裁 markers 条目；每层 base/transform 等固定字段
        // 已在 ⓪ 的 _over() 额度里（JSON.stringify(layers) 含各层全部字段，extra 含 result 包装与
        // warnings），因此能裁到真实 ≤RESPONSE_JSON_LIMIT。markersTotal 保真实条数（不被逐次裁小）。
        for (i = layers.length - 1; i >= 0 && _over(); i--) {
            var mkl = layers[i];
            if (!mkl || typeof mkl !== "object") continue;
            if (!_isArrayValue(mkl.markers) || mkl.markers.length === 0) continue;
            var _mkTotalKeep = mkl.markers.length;
            try {
                if (typeof mkl.markersTotal === "number" && mkl.markersTotal > _mkTotalKeep) {
                    _mkTotalKeep = mkl.markersTotal;
                }
            } catch (_) { }
            while (_over() && mkl.markers.length > 0) {
                mkl.markers.pop();
                mkl.markersTruncated = true;
                mkl.markersTotal = _mkTotalKeep;
                mkl.responseBytesTruncated = true;
                hit = true;
            }
        }
        // ② 形状：从最后一层起逐节点删（shapeNodeCount 按剩余节点重算，丢弃即 0）
        for (i = layers.length - 1; i >= 0 && _over(); i--) {
            var sl = layers[i];
            if (!sl || typeof sl !== "object" || !_isArrayValue(sl.shapeContents)) continue;
            while (_over()) {
                if (!_trimShapeOneNode(sl.shapeContents)) break;
                sl.shapeNodeCount = _countShapeNodes(sl.shapeContents);
                sl.shapeTruncated = true;
                sl.shapeBytesTruncated = true;
                sl.responseBytesTruncated = true;
                hit = true;
            }
        }
        // ③ 关键帧：从最后一层起逐条裁尾部键（最后手段，属性级标记同步）
        for (i = layers.length - 1; i >= 0 && _over(); i--) {
            var kl = layers[i];
            if (!kl || typeof kl !== "object") continue;
            while (_over()) {
                if (!_popOneKeyframe(kl)) break;
                // keyframesBudgetExhausted 只表示 12KB 关键帧预算真被撞到
                //（_kfTrim 置位）；兜底裁剪只置响应级标记。
                kl.responseBytesTruncated = true;
                hit = true;
            }
        }
        return hit;
    }
    // 结果组装处（getLayerInfo/getSelectedDetails）经预算体调用；固定字段导致的越界由这里兜底
    _kfBudget.enforceResponse = _enforceResponse;
    // references/markers 的计费在 getLayerInfo 里发生（_respCharge 是本函数局部声明），经预算体
    // 挂一个入口共用同一份 24000 计数与 clamp 语义；respRemain 供 markers
    // 在结果组装前按剩余额度从尾部裁（markers 是多层各自独立的数组，可安全裁剪）。
    _kfBudget.respCharge = _respCharge;
    _kfBudget.respRemain = _respRemain;
    // fields 组选择：只决定"返回哪些块"，块内细节仍由上面的 include* 开关控制。
    // 未传 = 现有默认（全部块；content 摘要在 layer 详情里默认不含，避免与 queryProject 重复）；
    // "*" = 全量组。合法性校验在 getLayerInfo，本函数只按 want 集合给现有构建逻辑加守卫。
    var _wantSet = null;
    var _wantAll = false;
    if (opts.fields !== undefined && opts.fields !== null && typeof opts.fields.length === "number") {
        _wantSet = {};
        for (var _wfI = 0; _wfI < opts.fields.length; _wfI++) {
            var _wfV = String(opts.fields[_wfI]);
            if (_wfV === "*") _wantAll = true;
            else _wantSet[_wfV] = true;
        }
    }
    function _wantField(name) {
        if (_wantSet === null) return (name !== "content");
        if (_wantAll) return true;
        return _wantSet[name] === true;
    }
    var info = {};
    if (_wantField("base")) {
        info = {
            index: layer.index,
            // 稳定键：与 index（层叠位置）并列回传，供调用方在后续调用里按 id 定位同一层
            layerId: _readLayerId(layer),
            name: layer.name,
            layerType: _getLayerType(layer),
            inPoint: layer.inPoint,
            outPoint: layer.outPoint,
            startTime: layer.startTime,
            stretch: layer.stretch,
            duration: layer.duration,
            hasVideo: layer.hasVideo,
            hasAudio: layer.hasAudio,
            is3D: layer.threeDLayer,
            enabled: layer.enabled,
            isHidden: layer.shy,
            isLocked: layer.locked,
            isSoloed: layer.solo,
            isAdjustmentLayer: (layer.adjustmentLayer === true),
            isGuideLayer: (layer.guideLayer === true),
            label: layer.label,
            blendingMode: (function () { try { return _blendModeName(layer.blendingMode); } catch (_) { return ''; } })(),
            // 原始数字码：名字映射未命中时据此排查（真机曾返回裸数字串 "5212"）
            blendingModeValue: (function () { try { return Number(layer.blendingMode); } catch (_) { return null; } })(),
            motionBlur: (function () { try { return !!layer.motionBlur; } catch (_) { return false; } })(),
            collapseTransformation: (function () { try { return !!layer.collapseTransformation; } catch (_) { return false; } })(),
            autoOrient: (function () { try { return _autoOrientName(layer.autoOrient); } catch (_) { return ''; } })(),
            frameBlending: (function () { try { return String(layer.frameBlending); } catch (_) { return ''; } })()
        };
        try {
            if (layer.parent) { info.parent = { index: layer.parent.index, name: layer.parent.name }; }
            else { info.parent = null; }
        } catch (_) { info.parent = null; }
    }

    // 合成帧字段：帧号 = round(秒 × 图层所属合成帧率)。关键帧 time 仍是层本地秒，
    // 不在此换算。帧率读不到时整组省略（不猜）。
    function _layerFrameOf(sec, fps) {
        var f = Math.round(Number(sec) * fps);
        return isFinite(f) ? f : null;
    }
    var _layerFps = 0;
    if (_wantField("frames")) {
        try { _layerFps = Number(layer.containingComp.frameRate) || 0; } catch (_) { _layerFps = 0; }
    }
    if (_layerFps > 0) {
        info.inFrame = _layerFrameOf(layer.inPoint, _layerFps);
        info.outFrame = _layerFrameOf(layer.outPoint, _layerFps);
        info.startFrame = _layerFrameOf(layer.startTime, _layerFps);
        info.durationFrames = _layerFrameOf(layer.duration, _layerFps);
    }
    // TrackMatteType 数字码 → alpha/alpha_inverted/luma/luma_inverted/none；
    // 枚举不可用（或本版本键名不同）时回退原始值字符串。
    function _trackMatteTypeName(v) {
        try {
            if (v === null || v === undefined) return "none";
            if (typeof TrackMatteType === "undefined") return String(v);
            var n = Number(v);
            if (TrackMatteType.ALPHA === n) return "alpha";
            if (TrackMatteType.ALPHA_INVERTED === n) return "alpha_inverted";
            if (TrackMatteType.LUMA === n) return "luma";
            if (TrackMatteType.LUMA_INVERTED === n) return "luma_inverted";
            if (TrackMatteType.NO_TRACK_MATTE === n) return "none";
        } catch (_) {}
        return String(v);
    }
    // 轨道遮罩：仅 AVLayer。trackMatteLayer 读不到（旧版 AE 无此属性）时
    // 省略整个字段——省略=该版本无此概念，null=有此概念但没挂遮罩。
    if (layer instanceof AVLayer && _wantField("trackMatte")) {
        var _tmReadable = true;
        var _tmLayer = null;
        try { _tmLayer = layer.trackMatteLayer; } catch (_) { _tmReadable = false; }
        if (_tmReadable) {
            if (!_tmLayer) {
                info.trackMatte = null;
            } else {
                info.trackMatte = { layerIndex: null, layerId: 0, layerName: "", type: null };
                try { info.trackMatte.layerIndex = Number(_tmLayer.index); } catch (_) {}
                try { info.trackMatte.layerId = _readLayerId(_tmLayer); } catch (_) {}
                try { info.trackMatte.layerName = String(_tmLayer.name); } catch (_) {}
                try { info.trackMatte.type = _trackMatteTypeName(layer.trackMatteType); } catch (_) {}
            }
        }
    }
    if (_wantField("base")) {
        try {
            if (layer instanceof AVLayer && layer.source) {
                var src = layer.source;
                info.source = {
                    name: src.name, sourceKind: _getSourceKind(src), duration: src.duration,
                    width: src.width, height: src.height, frameRate: src.frameRate,
                    hasAudio: src.hasAudio, hasVideo: src.hasVideo,
                    filePath: (src.mainSource && src.mainSource.file) ? String(src.mainSource.file.fsName) : ''
                };
                try { info.source.index = _getItemIndex(src); } catch (_) {}
            }
        } catch (_) {}
    }
    if (_wantField("transform")) {
        // 变换块：每个属性都给 value + keyframes + <name>Expression（空串 = 没有表达式）。
        // Audio Levels 与 5 个变换属性同写法——anim 指纹把它计入 hasExpression（在 ADBE Audio
        // Group 下经 getPropSafe 回退读取），详情这层缺该字段就会出现"指纹说有表达式、详情找不到"。
        // 关键帧走 _kfApply：一页窗口 + 响应级字节预算，另给 *KeyframesTotal/Offset/
        // Limit/HasMore/Truncated。未传 keyframeOffset/keyframeLimit 时每属性仍最多 30 条
        //（整份返回时——3000 键层单属性就 80 万字符）。表达式走 _exprEmit：
        // 超 800 字符截断并给 <key>Truncated/<key>Length。
        try { var posProp = getPropSafe(layer, "Position"); if (posProp) { info.position = posProp.value; _kfApply(info, "positionKeyframes", posProp); _exprEmit(info, "positionExpression", posProp); } } catch (_) {}
        try { var sclProp = getPropSafe(layer, "Scale"); if (sclProp) { info.scale = sclProp.value; _kfApply(info, "scaleKeyframes", sclProp); _exprEmit(info, "scaleExpression", sclProp); } } catch (_) {}
        try { var rotProp = getPropSafe(layer, "Rotation"); if (rotProp) { info.rotation = rotProp.value; _kfApply(info, "rotationKeyframes", rotProp); _exprEmit(info, "rotationExpression", rotProp); } } catch (_) {}
        try { var opaProp = getPropSafe(layer, "Opacity"); if (opaProp) { info.opacity = opaProp.value; _kfApply(info, "opacityKeyframes", opaProp); _exprEmit(info, "opacityExpression", opaProp); } } catch (_) {}
        try { var ancProp = getPropSafe(layer, "Anchor Point"); if (ancProp) { info.anchorPoint = ancProp.value; _kfApply(info, "anchorPointKeyframes", ancProp); _exprEmit(info, "anchorPointExpression", ancProp); } } catch (_) {}
        try { var audProp = getPropSafe(layer, "Audio Levels"); if (audProp) { info.audioLevels = audProp.value; _kfApply(info, "audioLevelsKeyframes", audProp); _exprEmit(info, "audioLevelsExpression", audProp); } } catch (_) {}
    }
    if (_wantField("base")) {
        try {
            // Material Options 仅对 3D 图层有意义，非 3D 层读取的值是噪音（LLM 反馈），跳过
            if (layer.threeDLayer) {
                var mo = getPropSafe(layer, "Material Options");
                if (mo) {
                    var mat = {};
                    try { var p1 = getSubProp(mo, "ADBE Casts Shadows", "Casts Shadows"); if (p1) mat.castsShadows = p1.value; } catch (_) {}
                    try { var p2 = getSubProp(mo, "ADBE Accepts Shadows", "Accepts Shadows"); if (p2) mat.acceptsShadows = p2.value; } catch (_) {}
                    try { var p3 = getSubProp(mo, "ADBE Accepts Lights", "Accepts Lights"); if (p3) mat.acceptsLights = p3.value; } catch (_) {}
                    try { var p4 = getSubProp(mo, "ADBE Ambient Coefficient", "Ambient"); if (p4) mat.ambient = p4.value; } catch (_) {}
                    try { var p5 = getSubProp(mo, "ADBE Diffuse Coefficient", "Diffuse"); if (p5) mat.diffuse = p5.value; } catch (_) {}
                    try { var p6 = getSubProp(mo, "ADBE Specular Coefficient", "Specular Intensity"); if (p6) mat.specularIntensity = p6.value; } catch (_) {}
                    try { var p7 = getSubProp(mo, "ADBE Shininess Coefficient", "Specular Shininess"); if (p7) mat.specularShininess = p7.value; } catch (_) {}
                    try { var p8 = getSubProp(mo, "ADBE Metal Coefficient", "Metal"); if (p8) mat.metal = p8.value; } catch (_) {}
                    info.materialOptions = mat;
                }
            }
        } catch (_) {}
    }
    if (_wantField("timeRemap")) {
        try {
            if (layer instanceof AVLayer && layer.timeRemapEnabled) {
                var trProp = getPropSafe(layer, "Time Remap");
                if (trProp) {
                    // 关键帧走同一窗口/预算：timeRemap.keyframes + keyframesTotal/...
                    // 表达式同 transform 口径：超 800 字符截断并给 expressionTruncated/
                    // expressionLength（这里在嵌套对象内，不与其它属性冲突，沿用无前缀名）
                    info.timeRemap = { enabled: true, value: trProp.value, keyframes: [] };
                    _exprEmit(info.timeRemap, "expression", trProp);
                    _kfApply(info.timeRemap, "keyframes", trProp);
                }
            } else { info.timeRemap = { enabled: false }; }
        } catch (_) {}
    }
    // 嵌套时间映射：AVLayer 且 source 是合成（precomp）。
    // stretch ≠ 100 或启用时间重映射时只标 nonLinear——源合成时间与合成时间的映射由 AE
    // 内部完成，不给换算公式；timeRemap 启用时附其关键帧（层本地秒，与 collectKeyframes 同口径）。
    try {
        if (layer instanceof AVLayer && _wantField("timeMap")) {
            var _precompSrc = null;
            try { _precompSrc = layer.source; } catch (_) { _precompSrc = null; }
            if (_precompSrc instanceof CompItem) {
                var _tmEnabled = false;
                try { _tmEnabled = (layer.timeRemapEnabled === true); } catch (_) { _tmEnabled = false; }
                var _tmStretch = 100;
                try { _tmStretch = Number(layer.stretch); } catch (_) { _tmStretch = 100; }
                if (isNaN(_tmStretch)) _tmStretch = 100;
                var _timeMap = {
                    sourceCompId: _readItemId(_precompSrc),
                    sourceCompName: "",
                    sourceDuration: null,
                    sourceFrameRate: null,
                    startTime: layer.startTime,
                    inPoint: layer.inPoint,
                    outPoint: layer.outPoint,
                    stretch: _tmStretch,
                    timeRemapEnabled: _tmEnabled
                };
                try { _timeMap.sourceCompName = String(_precompSrc.name); } catch (_) {}
                try { _timeMap.sourceDuration = _precompSrc.duration; } catch (_) {}
                try { _timeMap.sourceFrameRate = _precompSrc.frameRate; } catch (_) {}
                if (_tmEnabled) {
                    try {
                        var _timeRemapProp = getPropSafe(layer, "Time Remap");
                        if (_timeRemapProp && _timeRemapProp.numKeys > 0) {
                            // 与 timeRemap 块同一窗口/预算口径
                            _kfApply(_timeMap, "timeRemapKeyframes", _timeRemapProp);
                        }
                    } catch (_) {}
                }
                _timeMap.nonLinear = (_tmEnabled || _tmStretch !== 100);
                info.timeMap = _timeMap;
            }
        }
    } catch (_) {}
    // 载荷块（masks/effects）延后到形状与文本之后构建：响应级总预算按
    // 「关键帧 → 形状 → 载荷」扣费，后扣的先行被饿死，等价于总预算耗尽时按
    // 「载荷 → 形状 → 关键帧」收缩。函数声明被提升，调用点在 content 块之后。
    function _buildMasksEffects() {
    if (_wantField("effects")) {
        // 效果清单：一页窗口 + 载荷预算。条目本身很小（约 90B），但 100 条×5 层仍
        // 3.6 万字符；预算不足时从尾部收缩并置 effectsTruncated/payloadBytesTruncated。
        var effects = [];
        var _fxTotal = 0;
        var _fxPaging = _parsePaging({ offset: opts.effectOffset, limit: opts.effectLimit }, 20, 100);
        var _fxOff = _fxPaging.offset;
        var _fxBytesHit = false;
        try {
            var fxGroup = getPropSafe(layer, "Effects");
            if (fxGroup) {
                _fxTotal = Number(fxGroup.numProperties) || 0;
                if (_fxOff > _fxTotal) _fxOff = _fxTotal;
                var _fxStop = _fxOff + _fxPaging.limit;
                if (_fxStop > _fxTotal) _fxStop = _fxTotal;
                for (var i = _fxOff + 1; i <= _fxStop; i++) {
                    var eff = null;
                    try { eff = fxGroup.property(i); } catch (_) {}
                    if (!eff) continue;
                    var _fxRec = { name: eff.name, matchName: eff.matchName, enabled: eff.enabled, index: eff.propertyIndex };
                    if (!_payloadCharge(_payloadEntryBytes(_fxRec) + 1)) { _fxBytesHit = true; break; }
                    effects.push(_fxRec);
                }
            }
        } catch (_) {}
        info.effects = effects;
        info.effectsTotal = _fxTotal;
        info.effectsOffset = _fxOff;
        info.effectsLimit = _fxPaging.limit;
        info.effectsHasMore = (_fxOff + effects.length) < _fxTotal;
        info.nextEffectOffset = _fxOff + effects.length;
        if (_fxBytesHit || _fxOff > 0 || info.effectsHasMore) info.effectsTruncated = true;
        // 本页实际 0 条但组里确有条目（预算饿死）→ effectsStarved + Hint，
        // hasMore 置 false。旧契约下这里给 nextEffectOffset=起始 offset、hasMore=true，重试同一
        // 查询逐字节相同（原地死循环）。调用方看到 starved 改用 fields:['effects'] 或单层查询。
        if (_fxBytesHit && effects.length === 0 && _fxTotal > 0) {
            info.effectsStarved = true;
            info.effectsHasMore = false;
            info.effectsHint = "本页额度被关键帧/形状/动画器/样式占满；改用 fields:['effects'] 或单层查询";
        }
    }
    // 效果动画索引：每个效果的属性树里有几个叶子在动（有键或
    // 表达式），用于先判断"这个效果值不值得 target=effect 深挖"。只读 numKeys / expression，
    // 不读值、不展开参数树（参数树归 target=effect）。节点预算 300/层：达到即停止并置
    // effectAnimationCapped，被截断的那个效果带 truncated=true；无效果时给空数组。
    // fields 不含 effects 时不返回（fields 优先，与块级开关同一交集口径）。
    if (includeEffectAnimation && _wantField("effects")) {
        var fxAnimation = [];
        var fxAnimCapped = false;
        var fxNodeBudget = 300;
        var fxNodesUsed = 0;
        // 递归计数一个效果（或分组）下"在动"的叶子：numKeys>0 或 expression 非空。
        // 判组与 shapeContents / getEffectInfo 同口径：先看 propertyType
        // （INDEXED_GROUP/NAMED_GROUP 才是组），常量表缺失或未命中才退 numProperties>0。
        // 于是「0 子项组」在 propertyType 命中时仍算组（递归 0 次、不计叶子），否则算叶子。
        var _fxCountAnimatedLeaves = function (group, rec) {
            var childCount = 0;
            try { childCount = Number(group.numProperties) || 0; } catch (_) { childCount = 0; }
            for (var fci = 1; fci <= childCount; fci++) {
                if (fxNodesUsed >= fxNodeBudget) {
                    fxAnimCapped = true;
                    rec.truncated = true;
                    return;
                }
                var child = null;
                try { child = group.property(fci); } catch (_) {}
                fxNodesUsed++;
                if (!child) continue;
                var grandChildren = 0;
                try { grandChildren = Number(child.numProperties) || 0; } catch (_) { grandChildren = 0; }
                var childIsGroup = false;
                try {
                    if (child.propertyType === PropertyType.INDEXED_GROUP || child.propertyType === PropertyType.NAMED_GROUP) childIsGroup = true;
                } catch (_) { childIsGroup = false; }
                if (!childIsGroup && grandChildren > 0) childIsGroup = true;
                if (childIsGroup) {
                    _fxCountAnimatedLeaves(child, rec);
                    if (rec.truncated) return;
                    continue;
                }
                var leafKeys = 0;
                try { leafKeys = Number(child.numKeys) || 0; } catch (_) { leafKeys = 0; }
                var leafExpr = false;
                try {
                    var exprText = child.expression;
                    leafExpr = (exprText !== undefined && exprText !== null && String(exprText) !== "");
                } catch (_) { leafExpr = false; }
                if (leafExpr) rec.hasExpression = true;
                if (leafKeys > 0 || leafExpr) rec.animatedProps++;
            }
        };
        var fxAnimationGroup = null;
        try { fxAnimationGroup = getPropSafe(layer, "Effects"); } catch (_) { fxAnimationGroup = null; }
        if (fxAnimationGroup) {
            var fxAnimationCount = 0;
            try { fxAnimationCount = Number(fxAnimationGroup.numProperties) || 0; } catch (_) { fxAnimationCount = 0; }
            for (var fxi = 1; fxi <= fxAnimationCount; fxi++) {
                if (fxAnimCapped) break;   // 预算耗尽：停止扫描，不再产出后续效果（不假装 0）
                var fxNode = null;
                try { fxNode = fxAnimationGroup.property(fxi); } catch (_) {}
                fxNodesUsed++;
                if (!fxNode) continue;
                var fxRec = { effectName: "", effectIndex: 0, animatedProps: 0, hasExpression: false };
                try { fxRec.effectName = String(fxNode.name || ""); } catch (_) {}
                try {
                    var fxIdx = Number(fxNode.propertyIndex);
                    fxRec.effectIndex = (fxIdx > 0) ? fxIdx : fxi;
                } catch (_) { fxRec.effectIndex = fxi; }
                _fxCountAnimatedLeaves(fxNode, fxRec);
                fxAnimation.push(fxRec);
            }
        }
        info.effectAnimation = fxAnimation;
        if (fxAnimCapped) info.effectAnimationCapped = true;
        // 动画索引字节计入响应级 24000 总预算：不计费时 5 层×100 效果
        // + includeEffectAnimation 实测 35,505B，兜底只认 effects（已裁空）→ 裁不动。空数组不计费，
        // 薄数据（无效果/未开开关）体积与旧行为一致。
        if (fxAnimation.length > 0) {
            var _fxAnimBytes = 0;
            try { _fxAnimBytes = JSON.stringify(fxAnimation).length; } catch (_) { _fxAnimBytes = 0; }
            _respCharge(_fxAnimBytes);
        }
    }
    if (_wantField("masks")) {
        // 蒙版清单：一页窗口 + 载荷预算。蒙版条目带 Mask Path 形态与四条子属性
        // 关键帧，单条体积远大于效果；预算不足时从尾部收缩并置 masksTruncated/payloadBytesTruncated。
        var masks = [];
        var _mkTotal = 0;
        var _mkPaging = _parsePaging({ offset: opts.maskOffset, limit: opts.maskLimit }, 20, 100);
        var _mkOff = _mkPaging.offset;
        var _mkBytesHit = false;
        try {
            var maskGroup = getPropSafe(layer, "Masks");
            if (maskGroup) {
                _mkTotal = Number(maskGroup.numProperties) || 0;
                if (_mkOff > _mkTotal) _mkOff = _mkTotal;
                var _mkStop = _mkOff + _mkPaging.limit;
                if (_mkStop > _mkTotal) _mkStop = _mkTotal;
                for (var mi = _mkOff + 1; mi <= _mkStop; mi++) {
                    var mk = null;
                    try { mk = maskGroup.property(mi); } catch (_) {}
                    if (!mk) continue;
                    var mInfo = {
                        name: mk.name,
                        index: mk.propertyIndex,
                        enabled: mk.enabled,
                        locked: mk.locked
                    };
                    try { var mm = getPropSafe(mk, "Mask Mode"); if (mm) mInfo.maskMode = String(mm.value); } catch (_) {}
                    // 路径：当前时刻（CTI）形态 + 关键帧（顶点默认只给数量，includeMaskVertices:true 才展开坐标）。
                    // 关键帧按窗口构造（3000 键蒙版不再整份构造），再走同一响应级字节预算。
                    try {
                        var shapeProp = getPropSafe(mk, "Mask Path");
                        if (shapeProp) {
                            // 逐属性 offset：maskPath 未点名时回退 keyframeOffset 标量
                            var _ms = _readMaskShape(shapeProp, includeMaskVertices, _kfOffsetFor("maskPath", shapeProp), _kfLimit, opts.vertexLimit);
                            var _msSt = _kfTrim(_ms.keyframes, _ms.keyframesTotal, _ms.keyframesOffset, _ms.keyframesLimit);
                            _ms.keyframes = _msSt.list;
                            _ms.keyframesHasMore = _msSt.hasMore;
                            if (_msSt.truncated) _ms.keyframesTruncated = true;
                            if (_msSt.dropped) _ms.keyframesDropped = true;
                            mInfo.maskShape = _ms;
                        }
                    } catch (_) {}
                    // 羽化 / 不透明度 / 扩展：静态值 + 关键帧明细（同一窗口/预算口径）
                    try { var mop = getPropSafe(mk, "Mask Opacity"); if (mop) {
                        mInfo.maskOpacity = mop.value;
                        if (mop.numKeys > 0) _kfApply(mInfo, "maskOpacityKeyframes", mop);
                    } } catch (_) {}
                    try { var mf = getPropSafe(mk, "Mask Feather"); if (mf) {
                        mInfo.maskFeather = mf.value;
                        if (mf.numKeys > 0) _kfApply(mInfo, "maskFeatherKeyframes", mf);
                    } } catch (_) {}
                    try { var mEx = getPropSafe(mk, "Mask Expansion"); if (mEx) {
                        mInfo.maskExpansion = mEx.value;
                        if (mEx.numKeys > 0) _kfApply(mInfo, "maskExpansionKeyframes", mEx);
                    } } catch (_) {}
                    if (!_payloadCharge(_payloadEntryBytes(mInfo) + 1)) { _mkBytesHit = true; break; }
                    // 蒙版顶点：vertices 仍从载荷条目里豁免（否则单条 2000 顶点
                    // 蒙版会被整条丢弃），但按实际 JSON 单独计入响应级总预算。20 蒙版×200 顶点
                    // 合计 41,281B；额度不够就从尾部裁顶点数组（置
                    // verticesTruncated）并置层级/结果级 responseBytesTruncated，跨蒙版有总量上限。
                    if (includeMaskVertices) {
                        var _vBytes = _vertexBytesOf(mInfo);
                        if (_vBytes > 0) {
                            var _vAllow = _respRemain();
                            if (_vBytes > _vAllow) {
                                _vBytes = _trimVerticesToBudget(mInfo, _vAllow);
                                _respLayerHit = true;
                                _kfBudget.respExhausted = true;
                            }
                            _respCharge(_vBytes);
                        }
                    }
                    masks.push(mInfo);
                }
            }
        } catch (_) {}
        info.masks = masks;
        info.masksTotal = _mkTotal;
        info.masksOffset = _mkOff;
        info.masksLimit = _mkPaging.limit;
        info.masksHasMore = (_mkOff + masks.length) < _mkTotal;
        info.nextMaskOffset = _mkOff + masks.length;
        if (_mkBytesHit || _mkOff > 0 || info.masksHasMore) info.masksTruncated = true;
        // 同 effects——0 条但组里有蒙版（预算饿死）→ masksStarved + Hint，
        // hasMore=false。nextMaskOffset 仍是本次起点（诊断用），但不再暗示可直接续页。
        if (_mkBytesHit && masks.length === 0 && _mkTotal > 0) {
            info.masksStarved = true;
            info.masksHasMore = false;
            info.masksHint = "本页额度被关键帧/形状/动画器/样式占满；改用 fields:['masks'] 或单层查询";
        }
    }
    }
    // 形状图层内容树：从 Root Vectors Group 通用递归，不按 matchName 白名单写死。
    // 只读 name/matchName/propertyType/numProperties；叶子值/键/表达式只在 includeShapeValues:true 时读
    //（默认骨架：宿主调用与体积都压到最低）。不遍历效果与蒙版（两块已单列）。
    // 预算按导出节点数计（shapeNodeLimit，默认 200、上限 2000）：达到即停止展开并置 shapeTruncated。
    // 以下 helper 都是函数内局部声明（不新增顶层声明）。
    // 叶子值摘要：路径（Shape）只给 { vertexCount, closed }，不展开顶点数组；超长数组只给长度。
    function _shapeValueSummary(v) {
        if (v === null || v === undefined) return null;
        if (typeof v !== "object") return v;
        var verts = null;
        try { verts = v.vertices; } catch (_) { verts = null; }
        if (verts) {
            var vc = 0;
            try { vc = Number(verts.length) || 0; } catch (_) { vc = 0; }
            return { vertexCount: vc, closed: v.closed === true };
        }
        var len = 0;
        try { len = Number(v.length); } catch (_) { len = 0; }
        if (len > 0) {
            if (len > 64) return { arrayLength: len };
            var arr = [];
            for (var ai = 0; ai < len; ai++) arr.push(v[ai]);
            return arr;
        }
        try { return String(v); } catch (_) { return null; }
    }
    // 叶子关键帧：复用 collectKeyframes（与变换属性同口径）；路径关键帧的 value 换成摘要。
    // 窗口：off/lim 与 collectKeyframes 同口径，只构造该窗口。
    function _shapeKeyframes(prop, off, lim) {
        var kfs = collectKeyframes(prop, off, lim);
        for (var ki = 0; ki < kfs.length; ki++) {
            var kv = kfs[ki].value;
            var isPath = false;
            try { isPath = (kv && typeof kv === "object" && kv.vertices) ? true : false; } catch (_) { isPath = false; }
            if (isPath) {
                try { kfs[ki].value = _shapeValueSummary(kv); } catch (_) {}
            }
        }
        return kfs;
    }
    // 形状叶子关键帧输出：**不进关键帧字节预算**（不再走 _kfTrim/_kfUsed）。
    // 形状整树已由 SHAPE_BYTE_BUDGET 计费；两套预算叠加会在重建时把 kfUsed 撑满——第一趟把叶子键
    // 全计费，重建后 kfUsed 还是第一趟的值，第二趟的叶子键全被挡（真机 10 叶×30 键 → 叶子键 0 条、
    // 10/10 dropped，且续页公式 0+0 原地）。这里只按「单叶字节上限」给窗口：装不下就少给几条键并
    // 保留 total/offset/hasMore（可续页），而不是整段 dropped；形状截断统一用 shapeBytesTruncated。
    // _shapeLeafKfBytes 由形状块按剩余预算设置（0 = 不限）。
    var _shapeLeafKfBytes = 0;
    function _shapeLeafKfEmit(node, list, total, off, limit) {
        var kept = [];
        var bytes = 0;
        for (var i = 0; i < list.length; i++) {
            var ib = 0;
            try { ib = JSON.stringify(list[i]).length; } catch (_) { ib = 0; }
            var add = ib + (kept.length > 0 ? 1 : 0);
            // 至少留 1 条：0 条会让续页公式原地（offset + 0）且看不到任何明细
            if (_shapeLeafKfBytes > 0 && kept.length > 0 && bytes + add > _shapeLeafKfBytes) break;
            kept.push(list[i]);
            bytes += add;
        }
        node.keyframes = kept;
        node.keyframesTotal = total;
        node.keyframesOffset = off;
        node.keyframesLimit = limit;
        node.keyframesHasMore = (off + kept.length) < total;
        if (off > 0 || kept.length < total) node.keyframesTruncated = true;
    }
    // 单节点：判为组 → kind=group 并递归 children；叶子默认只给骨架，includeShapeValues:true 才给值/键/表达式。
    function _readShapeChild(prop, budget) {
        if (!prop) return null;
        if (budget.used >= budget.cap) { budget.truncated = true; return null; }
        var node = { name: "", matchName: "", kind: "property" };
        try { node.name = String(prop.name || ""); } catch (_) {}
        try { node.matchName = String(prop.matchName || ""); } catch (_) {}
        var ptype = 0;
        try { ptype = Number(prop.propertyType); } catch (_) { ptype = 0; }
        // 组判定：官方三成员 PROPERTY（叶子，真机 6212）/INDEXED_GROUP（6214）/
        // NAMED_GROUP（6213）；组只认后两者。PROPERTY_GROUP 在宿主不存在（读写为 undefined），
        // 引用它会让判组恒假。常量表不可用或仍不命中时退到 numProperties > 0
        //（叶子属性读不到可用的子项数）。
        var isGroup = false;
        try {
            if (ptype === PropertyType.INDEXED_GROUP || ptype === PropertyType.NAMED_GROUP) isGroup = true;
        } catch (_) { isGroup = false; }
        if (!isGroup) {
            try { if (Number(prop.numProperties) > 0) isGroup = true; } catch (_) { isGroup = false; }
        }
        if (isGroup) {
            node.kind = "group";
            var childCount = 0;
            try { childCount = Number(prop.numProperties) || 0; } catch (_) { childCount = 0; }
            node.numProperties = childCount;
            budget.used++;
            node.children = _readShapeChildren(prop, budget);
            return node;
        }
        budget.used++;
        if (!includeShapeValues) return node;   // 骨架：叶子到此为止（不读 value/numKeys/keyframes/expression）
        try { node.value = _shapeValueSummary(prop.value); } catch (_) { node.value = null; }
        var nk = 0;
        try { nk = Number(prop.numKeys) || 0; } catch (_) { nk = 0; }
        node.numKeys = nk;
        if (nk > 0) {
            // 窗口与其它 layer 路径同口径（keyframeOffset/keyframeLimit），但按单叶字节上限收缩
            // （不再计入关键帧预算，见 _shapeLeafKfEmit）
            // 每片叶子可按 keyframeOffsets.shapeContents 或该叶 matchName 单独取起点
            var _leafOff = _kfOffsetFor("shapeContents", prop);
            if (_leafOff > nk) _leafOff = nk;
            var _leafList = [];
            try { _leafList = _shapeKeyframes(prop, _leafOff, _kfLimit); } catch (_) { _leafList = []; }
            _shapeLeafKfEmit(node, _leafList, nk, _leafOff, _kfLimit);
        }
        var expr = "";
        try { expr = String(prop.expression || ""); } catch (_) { expr = ""; }
        if (expr) {
            if (expr.length > 500) {
                node.expression = expr.substring(0, 500);
                node.expressionTruncated = true;
            } else {
                node.expression = expr;
            }
        }
        return node;
    }
    function _readShapeChildren(group, budget) {
        var out = [];
        var count = 0;
        try { count = Number(group.numProperties) || 0; } catch (_) { count = 0; }
        for (var si = 1; si <= count; si++) {
            if (budget.used >= budget.cap) { budget.truncated = true; break; }
            var child = null;
            try { child = group.property(si); } catch (_) { child = null; }
            var childNode = _readShapeChild(child, budget);
            if (childNode) out.push(childNode);
        }
        return out;
    }
    if (includeShapeContents && _wantField("shapeContents")) {
        // 非形状层恒为 null（字段恒在，调用方不必判 undefined）；关闭开关时字段整体省略。
        info.shapeContents = null;
        try {
            if (layer instanceof ShapeLayer) {
                var _shapeRoot = null;
                try { _shapeRoot = layer.property("ADBE Root Vectors Group"); } catch (_) { _shapeRoot = null; }
                if (_shapeRoot) {
                    // 形状树字节预算：整树 JSON 计入 shapeUsed；叶子关键帧也在这棵树里，
                    // 因此不另计关键帧预算（见 _shapeLeafKfEmit）。装不下时按剩余额度等比收缩「节点数
                    // 预算 + 单叶关键帧字节上限」重建，直到装下或节点预算缩到 1。
                    // 额度取「形状 12KB 剩余」与「响应级总预算剩余」的较小值；
                    // 被总预算卡住时同样收缩并置 responseBytesTruncated。
                    var _shapeCap = shapeNodeLimit;
                    var _shapeLeafKfLimit = SHAPE_LEAF_KF_BYTES;
                    var _shapeBudget = { used: 0, cap: _shapeCap, truncated: false };
                    _shapeLeafKfBytes = _shapeLeafKfLimit;
                    var _shapeNodes = _readShapeChildren(_shapeRoot, _shapeBudget);
                    var _shapeJson = 0;
                    try { _shapeJson = JSON.stringify(_shapeNodes).length; } catch (_) { _shapeJson = 0; }
                    var _shapeSubRemain = SHAPE_BYTE_BUDGET - _kfBudget.shapeUsed;
                    if (_shapeSubRemain < 0) _shapeSubRemain = 0;
                    var _shapeRespRemain = _respRemain();
                    var _shapeRespBound = (_shapeRespRemain < _shapeSubRemain);
                    var _shapeAllow = _shapeRespBound ? _shapeRespRemain : _shapeSubRemain;
                    if (_shapeAllow < 0) _shapeAllow = 0;
                    var _shapePass = 0;
                    while (_shapeNodes.length > 0 && _shapeJson > _shapeAllow && _shapeCap > 1 && _shapePass < 12) {
                        _shapePass++;
                        var _shapeRemain = _shapeAllow;
                        var _shapeDen = _shapeJson > 0 ? _shapeJson : 1;
                        // 节点预算大于实际导出数时先归一到实际数：否则按 99% 比例每趟只缩几个节点，
                        // 要重建上百趟（宽树 + 每叶固定开销时的收敛问题）
                        var _shapeEffCap = (_shapeCap > _shapeBudget.used) ? _shapeBudget.used : _shapeCap;
                        var _nextCap = Math.floor(_shapeEffCap * _shapeRemain / _shapeDen);
                        if (_nextCap >= _shapeEffCap) _nextCap = _shapeEffCap - 1;
                        if (_nextCap < 1) _nextCap = 1;      // 至少留根组骨架（节点预算 0 = 空树，比丢弃更难读）
                        var _nextLeaf = Math.floor(_shapeLeafKfLimit * _shapeRemain / _shapeDen);
                        if (_nextLeaf < 64) _nextLeaf = 64;  // 至少约 1 条键的额度
                        _shapeCap = _nextCap;
                        _shapeLeafKfLimit = _nextLeaf;
                        _shapeLeafKfBytes = _shapeLeafKfLimit;
                        _shapeBudget = { used: 0, cap: _shapeCap, truncated: true, bytesTruncated: true };
                        _shapeNodes = _readShapeChildren(_shapeRoot, _shapeBudget);
                        try { _shapeJson = JSON.stringify(_shapeNodes).length; } catch (_) { _shapeJson = 0; }
                    }
                    // 仍装不下（单节点就超预算 / 额度已耗尽）：整份丢弃并如实标注。
                    // 丢弃时 shapeNodeCount 归 0，不再报上一趟重建的 used。
                    if (_shapeNodes.length > 0 && _shapeJson > _shapeAllow) {
                        _shapeNodes = [];
                        _shapeJson = 2;
                        _shapeBudget.truncated = true;
                        _shapeBudget.bytesTruncated = true;
                        _shapeBudget.dropped = true;
                    }
                    _kfBudget.shapeUsed += _shapeJson;
                    _respCharge(_shapeJson);
                    info.shapeContents = _shapeNodes;
                    info.shapeNodeCount = _shapeBudget.dropped ? 0 : _shapeBudget.used;
                    if (_shapeBudget.bytesTruncated || _shapeBudget.dropped) {
                        _shapeLayerHit = true;
                        _kfBudget.shapeExhausted = true;
                        info.shapeBytesTruncated = true;
                    }
                    if (_shapeBudget.bytesTruncated || _shapeBudget.dropped) {
                        // 响应级总预算比形状 12KB 先耗尽时，额外置响应级标记
                        if (_shapeRespBound) {
                            _respLayerHit = true;
                            _kfBudget.respExhausted = true;
                        }
                    }
                    if (_shapeBudget.truncated) info.shapeTruncated = true;
                }
            }
        } catch (_) {}
    }
    if (_wantField("base")) {
        try {
            var t = comp ? comp.time : 0;
            var rect = layer.sourceRectAtTime(t, false);
            if (rect) {
                info.contentWidth = Math.round(rect.width * 100) / 100;
                info.contentHeight = Math.round(rect.height * 100) / 100;
                info.contentLeft = Math.round(rect.left * 100) / 100;
                info.contentTop = Math.round(rect.top * 100) / 100;
            }
        } catch (_) {}
    }
    if (_wantField("text")) {
        try {
            if (layer instanceof TextLayer) {
                info.isTextLayer = true;
                var textProp = layer.property("ADBE Text Properties").property("ADBE Text Document");
                // Source Text 表达式（空串 = 没有表达式）：与 transform 块各属性同一语义。
                // anim 指纹把 Source Text 计入 hasExpression，这里缺字段同样会出现"指纹说有、详情找不到"。
                // 超 800 字符截断并给 sourceTextExpressionTruncated/sourceTextExpressionLength。
                _exprEmit(info, "sourceTextExpression", textProp);
                var textDoc = textProp.value;
                // 当前文本上限：超 2000 只给前 2000 + textTruncated + textLength；
                // ≤2000（含读不到时的字段省略）与旧行为一致。
                var _fullText = null;
                try { _fullText = String(textDoc.text || textDoc); } catch (_) { _fullText = null; }
                if (_fullText !== null) {
                    if (_fullText.length > TEXT_SHOW_LIMIT) {
                        info.text = _fullText.substring(0, TEXT_SHOW_LIMIT);
                        info.textTruncated = true;
                        info.textLength = _fullText.length;
                    } else {
                        info.text = _fullText;
                    }
                }
                try { info.fontSize = textDoc.fontSize; } catch (_) {}
                try { info.fontFamily = textDoc.font; } catch (_) {}
                try { info.fontStyle = textDoc.fontStyle; } catch (_) {}
                try { info.fillColor = textDoc.fillColor; } catch (_) {}
                try { info.strokeColor = textDoc.strokeColor; } catch (_) {}
                try { info.strokeWidth = textDoc.strokeWidth; } catch (_) {}
                try { info.tracking = textDoc.tracking; } catch (_) {}
                try { info.leading = textDoc.leading; } catch (_) {}
                try { info.justification = textDoc.justification; } catch (_) {}
                try { info.applyFill = textDoc.applyFill; } catch (_) {}
                try { info.applyStroke = textDoc.applyStroke; } catch (_) {}
                try { info.pointText = textDoc.pointText; } catch (_) {}
                // 文本内容关键帧（逐帧文本）：Source Text 属性动画；与其它 layer 路径同一
                // 窗口/预算口径
                try {
                    if (textProp.numKeys > 0) {
                        var _stTotal = Number(textProp.numKeys) || 0;
                        var _stOff = _kfOffsetFor("sourceText", textProp);
                        if (_stOff > _stTotal) _stOff = _stTotal;
                        var _stList = _readSourceTextKeyframes(textProp, _stOff, _kfLimit);
                        _kfEmit(info, "sourceTextKeyframes", _kfTrim(_stList, _stTotal, _stOff, _kfLimit));
                    }
                } catch (_) {}
            }
        } catch (_) {}
    }
    // 文本动画器（逐字/逐词偏移、范围选择器）；includeTextAnimators:false 可关。
    // 非文本层也回空数组（字段恒在，调用方不必判 undefined）。
    // 三层上限：① 条数窗口 textAnimatorOffset/textAnimatorLimit（默认 0/20、上限 100，_parsePaging 口径）；
    // ② 本层动画器 JSON 字节预算 TEXT_ANIMATOR_BYTE_BUDGET=6000（从尾部裁）；单条动画器自身
    //    超过 6000B 时（AE 动画器属性组约 95 条属性，单条 JSON 约 7KB+）按本次响应剩余额度判定：
    //    够则上限抬到该条自身大小、本页优先返回该条（每页最多退让一条），不够则该条不可读；
    // ③ 结果组装时 _enforceResponse 继续裁。每层恒给 textAnimatorsTotal/Offset/Limit/HasMore/
    // nextTextAnimatorOffset 与 textAnimatorsTruncated（窗口或预算截断都为 true，未截断为 false）；
    // 预算截断另置 textAnimatorsBytesTruncated 与 responseBytesTruncated。续页用
    // nextTextAnimatorOffset 当下一层的 textAnimatorOffset。
    if (includeTextAnimators && _wantField("textAnimators")) {
        var _taPaging = _parsePaging({ offset: opts.textAnimatorOffset, limit: opts.textAnimatorLimit }, 20, 100);
        var _taTotal = 0;
        var _taOff = _taPaging.offset;
        var _taRaw = [];
        try {
            if (layer instanceof TextLayer) {
                var _taTp = null;
                try { _taTp = layer.property("ADBE Text Properties"); } catch (_) { _taTp = null; }
                var _taGroup = null;
                try { _taGroup = _taTp ? _taTp.property("ADBE Text Animators") : null; } catch (_) { _taGroup = null; }
                if (_taGroup) {
                    try { _taTotal = Number(_taGroup.numProperties) || 0; } catch (_) { _taTotal = 0; }
                    if (_taOff > _taTotal) _taOff = _taTotal;
                    // 只构造该页（不整份构造后再裁，省宿主调用）
                    if (_taOff < _taTotal) _taRaw = _readTextAnimators(_taTp, _taOff, _taPaging.limit);
                }
            }
        } catch (_) {}
        var _taKept = [];
        var _taBytes = 2;                  // "[]" 自身
        var _taBytesHit = false;
        // 层内预算；首条动画器自身超过它时按本次响应剩余额度判定：够则上限抬到「该条 JSON+2」
        //（本页至少返回该条，每页最多退让一条），其余条目按 nextTextAnimatorOffset 续页。
        var _taCap = TEXT_ANIMATOR_BYTE_BUDGET;
        if (_taRaw.length > 0) {
            var _taFirstBytes = 0;
            try { _taFirstBytes = JSON.stringify(_taRaw[0]).length + 2; } catch (_) { _taFirstBytes = 0; }
            if (_taFirstBytes > _taCap && _taFirstBytes <= _respRemain()) _taCap = _taFirstBytes;
        }
        for (var _tai = 0; _tai < _taRaw.length; _tai++) {
            var _tab = 0;
            try { _tab = JSON.stringify(_taRaw[_tai]).length; } catch (_) { _tab = 0; }
            var _taAdd = _tab + (_taKept.length > 0 ? 1 : 0);
            if (_taBytes + _taAdd > _taCap) { _taBytesHit = true; break; }
            _taKept.push(_taRaw[_tai]);
            _taBytes += _taAdd;
        }
        info.textAnimators = _taKept;
        // 0 个动画器（非文本层/无动画器文本层）：只给空数组，不追加分页字段——薄数据体积与
        // 旧行为一致（形状/普通图层的详情不被这组字段撑大）。
        if (_taTotal > 0) {
            info.textAnimatorsTotal = _taTotal;
            info.textAnimatorsOffset = _taOff;
            info.textAnimatorsLimit = _taPaging.limit;
            info.textAnimatorsHasMore = (_taOff + _taKept.length) < _taTotal;
            info.nextTextAnimatorOffset = _taOff + _taKept.length;
            info.textAnimatorsTruncated = (_taBytesHit || _taOff > 0 || info.textAnimatorsHasMore);
        }
        if (_taBytesHit) {
            info.textAnimatorsBytesTruncated = true;
            info.responseBytesTruncated = true;
        }
        // 本页动画器为空但组里确有条目：单条动画器超出本次响应剩余额度（退让后仍装不下），
        // 分页只按动画器切、切不出单条内部属性，故置 starved 并给替代路径；HasMore 置 false，
        // nextTextAnimatorOffset 保留本次起点（诊断用），不暗示可直接续页。
        if (_taBytesHit && _taKept.length === 0 && _taTotal > 0) {
            // 请求已把 fields 收窄到只剩 textAnimators 时，「改用该字段」不成立，直接给导出路径。
            var _taFieldKeys = 0;
            if (_wantSet !== null && !_wantAll) {
                for (var _taFk in _wantSet) {
                    if (Object.prototype.hasOwnProperty.call(_wantSet, _taFk)) _taFieldKeys++;
                }
            }
            var _taNarrowed = (_taFieldKeys === 1 && _wantSet.textAnimators === true);
            info.textAnimatorsStarved = true;
            info.textAnimatorsHasMore = false;
            info.textAnimatorsHint = _taNarrowed
                ? "单条动画器超出本次响应剩余额度；已按 fields:['textAnimators'] 收窄仍装不下，改用 executeExtendScript 只读导出"
                : "单条动画器超出本次响应剩余额度；改用 fields:['textAnimators'] 单层查询，仍装不下时用 executeExtendScript 只读导出";
        }
        // 动画器字节计入响应级总预算；空数组（非文本层/无动画器）不计费。
        if (_taTotal > 0) _respCharge(_taBytes);
    }
    // 图层样式：列全部样式子组（未启用也返回，带 enabled），外加全局光（混合选项组的角度/高度）；
    // includeLayerStyles:false 可关。参数树递归展开子组（子组最多展开 2 层，第 3 层起只留骨架并带
    // depthCapped；整层节点预算 LAYER_STYLE_NODE_LIMIT），每个叶子的关键帧只给 numKeys、
    // 表达式非空才给文本（≤800 截断）；includeLayerStyleAnimation:true 才展开关键帧（走 _kfApply：
    // keyframeOffset/keyframeLimit 窗口 + 12KB 关键帧预算 + 逐属性 matchName 起点），且只给裁剪后
    // 仍保留的条目补，不替被裁条目付预算。超 LAYER_STYLE_BYTE_BUDGET 从尾部裁（已启用排在前面，
    // 先丢未启用条目），有样式时给 layerStylesTotal/layerStylesEnabledTotal/layerStylesTruncated，
    // 字节裁断另置 layerStylesBytesTruncated + responseBytesTruncated；字节计入响应级 respUsed。
    if (includeLayerStyles && _wantField("layerStyles")) {
        try {
            var _lsAnim = opts.includeLayerStyleAnimation === true;
            var _lsReader = {
                maxDepth: 3,
                nodeBudget: { used: 0, limit: LAYER_STYLE_NODE_LIMIT, capped: false },
                currentStyle: null,   // 正在读的样式记录；关键帧延后到裁剪后只给保留条目补
                leafPairs: [],
                readLeaf: function (rec, prop) {
                    try { rec.value = prop.value; } catch (_) { rec.value = null; }
                    var nk = 0;
                    try { nk = Number(prop.numKeys) || 0; } catch (_) { nk = 0; }
                    if (nk > 0) {
                        rec.numKeys = nk;
                        if (_lsAnim) _lsReader.leafPairs.push({ rec: rec, prop: prop, style: _lsReader.currentStyle });
                    }
                    var expr = "";
                    try { expr = (prop.expression === undefined || prop.expression === null) ? "" : String(prop.expression); }
                    catch (_) { expr = ""; }
                    if (!expr) return;
                    if (expr.length > EXPR_SHOW_LIMIT) {
                        rec.expression = expr.substring(0, EXPR_SHOW_LIMIT);
                        rec.expressionTruncated = true;
                        rec.expressionLength = expr.length;
                    } else {
                        rec.expression = expr;
                    }
                }
            };
            var lsInfo = _readLayerStyles(layer, opts, _lsReader);
            var _lsTotal = lsInfo.styles.length;
            var _lsEnabledTotal = 0;
            for (var _lse = 0; _lse < _lsTotal; _lse++) {
                if (lsInfo.styles[_lse].enabled === true) _lsEnabledTotal++;
            }
            var _lsKept = [];
            var _lsBytes = 2;                  // "[]" 自身
            var _lsBytesHit = false;
            // 裁剪期记录里还没有关键帧（关键帧在裁完之后只给保留条目补），所以这里按整条 JSON 计。
            // 装不下的条目退化为骨架（enabled/index + paramsTruncated 或 paramsUnread）后停止：
            // 调用方仍看得到有多少样式、哪些启用，参数改 fields:['layerStyles'] 单层查。
            // 骨架**不受 6000B 约束**——预算通常已被前面的整条吃满，留缝判断会让它永远进不来；
            // 每个响应层最多因此超出约一条骨架（百字节级），硬上限仍由结果兜底把关。
            for (var _lsi = 0; _lsi < lsInfo.styles.length; _lsi++) {
                var _lsb = 0;
                try { _lsb = JSON.stringify(lsInfo.styles[_lsi]).length; } catch (_) { _lsb = 0; }
                if (_lsb < 0) _lsb = 0;
                var _lsAdd = _lsb + (_lsKept.length > 0 ? 1 : 0);
                if (_lsBytes + _lsAdd > LAYER_STYLE_BYTE_BUDGET) {
                    _lsBytesHit = true;
                    var _lsOver = lsInfo.styles[_lsi];
                    var _lsSkel = {
                        name: _lsOver.name, matchName: _lsOver.matchName,
                        enabled: _lsOver.enabled, index: _lsOver.index
                    };
                    if (_lsOver.paramsUnread) _lsSkel.paramsUnread = true;
                    else _lsSkel.paramsTruncated = true;
                    var _lsSkelBytes = 0;
                    try { _lsSkelBytes = JSON.stringify(_lsSkel).length; } catch (_) { _lsSkelBytes = 0; }
                    _lsKept.push(_lsSkel);
                    _lsBytes += _lsSkelBytes + (_lsKept.length > 1 ? 1 : 0);
                    break;
                }
                _lsKept.push(lsInfo.styles[_lsi]);
                _lsBytes += _lsAdd;
            }
            // 本块字节先计费，再放关键帧：_kfTrim 按剩余 respUsed 放行，先计费才不会让
            // 样式自己的关键帧看着"额度还很宽"（否则账面可低估本块最多约 6000B）。
            if (_lsTotal > 0) _respCharge(_lsBytes);
            // 关键帧延后补：只给真正保留的条目出关键帧，被 6000B 裁掉的样式不再占 12KB 关键帧预算。
            // 起点：该参数 matchName 显式给了 keyframeOffsets 就用它（更具体，优先），否则整块
            // "layerStyle" 起点；matchName 命中的键记入已消费表，避免被回显成未知键。
            if (_lsAnim && _lsReader.leafPairs.length > 0) {
                for (var _lsp = 0; _lsp < _lsReader.leafPairs.length; _lsp++) {
                    var _lsPair = _lsReader.leafPairs[_lsp];
                    var _lsPairKept = false;
                    for (var _lsk = 0; _lsk < _lsKept.length; _lsk++) {
                        if (_lsKept[_lsk] === _lsPair.style) { _lsPairKept = true; break; }
                    }
                    if (!_lsPairKept) continue;
                    var _lsPairPrefix = "layerStyle";
                    try {
                        var _lsMn = String(_lsPair.prop.matchName || "");
                        if (_lsMn && _kfOffsets && typeof _kfOffsets[_lsMn] === "number") {
                            _lsPairPrefix = _lsMn;
                            _kfUsedMatchNames[_lsMn] = true;
                        }
                    } catch (_) { _lsPairPrefix = "layerStyle"; }
                    _kfApply(_lsPair.rec, "keyframes", _lsPair.prop, _lsPairPrefix);
                }
                // 关键帧元数据（keyframesTotal/Offset/Limit/HasMore/…）不在 _kfTrim 的计费里
                //（它只算数组 JSON），这里补一次响应级计费，避免账面低估 24000。
                var _lsAfter = 0;
                try { _lsAfter = JSON.stringify(_lsKept).length; } catch (_) { _lsAfter = 0; }
                var _lsMetaBytes = _lsAfter - _lsBytes - _sumExemptBytes(_lsKept, 0);
                if (_lsMetaBytes > 0) _respCharge(_lsMetaBytes);
            }
            info.layerStyles = _lsKept;
            // 0 个样式子组（组缺失或空）：只给空数组，不追加分页字段——薄数据体积与旧行为一致。
            // layerStylesTotal 是全部样式条数（含未启用），layerStylesEnabledTotal 是其中已启用的。
            if (_lsTotal > 0) {
                info.layerStylesTotal = _lsTotal;
                info.layerStylesEnabledTotal = _lsEnabledTotal;
                info.layerStylesTruncated = (_lsBytesHit || _lsKept.length < _lsTotal);
            }
            if (_lsReader.nodeBudget.capped) info.layerStylesNodeCapped = true;
            if (_lsBytesHit) {
                info.layerStylesBytesTruncated = true;
                info.responseBytesTruncated = true;
            }
            if (lsInfo.lighting) info.layerStyleLighting = lsInfo.lighting;
        } catch (_) {}
    }
    // content 摘要（复用 queryProject 的同一函数）：只有 fields 里点名才给——layer 详情默认
    // 不重复摘要（摘要属模糊层，见 queryProject(target=layers) 的 content）。
    if (_wantField("content")) {
        try { info.content = _getLayerContentSummary(layer); } catch (_) {}
    }
    // 载荷延后构建：形状/文本先扣响应级总预算，载荷最后扣
    _buildMasksEffects();
    // 预算标记：只有本层真的因字节预算少输出了关键帧时才置位（精确用满不置）
    // 形状/蒙版/效果各自的截断标记在各自块里置（shapeBytesTruncated / masksTruncated /
    // effectsTruncated），这里只管关键帧/载荷两级（含 payloadBytesTruncated）。
    // 响应级总预算（关键帧/形状/载荷/顶点）任一被收缩，另置
    // responseBytesTruncated；三个分项标记语义不变（各自 12KB 是否真被撞到）。
    if (_kfLayerHit) info.keyframesBudgetExhausted = true;
    if (_payloadLayerHit) info.payloadBytesTruncated = true;
    if (_respLayerHit) info.responseBytesTruncated = true;
    // 未知 keyframeOffsets 键：既不是已知输出前缀（大小写不敏感），也没有命中
    // 任何已读取属性的 matchName → 计入预算体的 kfOffsetsIgnored，结果组装时回显到
    // keyframeOffsetsIgnored（原键；同页多层重复的键只记一次）。positionKeyframes 这类带后缀
    // 的写法不是合法键，会在此被回显，避免调用方以为 offset 生效。
    for (var _koi = 0; _koi < _kfOtherKeys.length; _koi++) {
        var _koName2 = _kfOtherKeys[_koi];
        if (_kfUsedMatchNames[_koName2] === true) continue;
        var _ignList = _kfBudget.kfOffsetsIgnored;
        if (!_isArrayValue(_ignList)) {
            _ignList = [];
            _kfBudget.kfOffsetsIgnored = _ignList;
        }
        var _ignDup = false;
        for (var _igi = 0; _igi < _ignList.length; _igi++) {
            if (_ignList[_igi] === _koName2) { _ignDup = true; break; }
        }
        if (!_ignDup) _ignList.push(_koName2);
    }
    return info;
}

// Item 全局索引映射缓存（id → 1-based index + 下标→对象引用数组）。
// 生命期 = 模块（一次面板会话）；失效判据 = app.project.numItems 与建表时不一致时重建，
// 且每个命中都用 app.project.item(hit) 复核该下标仍是同一对象（防"删一个又加一个"总数
// 不变时缓存索引移位）。缓存变量必须是模块级私有名：它出现在授权代码可达的作用域链上，
// 故同时登记进 _INTERNAL_NAMES 文本黑名单（防漂移测试兜底）。
// 真机复现：删除并重建项目条目、numItems 不变时，旧缓存里的宿主对象已失效；
// 用 cache.refs[i] === target 做身份比较兜底时，ExtendScript 对已删除对象做比较直接抛
// "ReferenceError: 对象无效"，browse 与所有按 compositionId 的查询连带全报错，直到条目数
// 变化才自愈（加一个临时合成即恢复）。故有 id 时一律按 id 逐条比对（每次读 id 都 try/catch），
// 身份比较只留给读不到 id 的旧版 AE。
var _itemIndexCache = { n: -1, byId: null, refs: null };

// 一次线性遍历建索引：宿主调用数 O(n)，此后逐条目查询 O(1)。
// 性能背景：_getItemIndex 被 browse 逐条目 / selected 逐图层调用，若每次全扫
// app.project.numItems（k 次查询 = k×n 宿主调用），大工程下把 AE 主线程拖住数秒到数十秒；
// 建表后单次查询只余一次"下标复核"宿主调用。
function _buildItemIndexMap() {
    var n = app.project.numItems;
    var byId = {};
    var refs = [];
    for (var i = 1; i <= n; i++) {
        var it = app.project.item(i);
        refs[i] = it;
        var id = 0;
        try { id = Math.floor(Number(it.id)); if (!(id > 0)) id = 0; } catch (_) { id = 0; }
        if (id > 0) byId[id] = i;
    }
    _itemIndexCache = { n: n, byId: byId, refs: refs };
    return _itemIndexCache;
}

// 查 Item 对象在 app.project 中的全局 1-based 索引。
// AE 的 Item 对象没有 index 属性（_getItemIndex(comp)/_getItemIndex(item) 恒为 undefined），
// 必须靠遍历/映射用引用相等匹配。用于 browse/selected/search/diagnostics
// 等场景，确保返回的 compositionIndex/footageIndex/index 能被 LLM 直接用于 app.project.item(idx)。
// 语义与旧线性实现严格等价：找不到（含 target 为 null）返回 -1；app.project 不可用时的
// 异常行为不变（取 numItems 处即抛）。
function _getItemIndex(target) {
    if (!target) return -1;
    var n = app.project.numItems;
    var cache = _itemIndexCache;
    var justBuilt = false;
    if (!cache.byId || cache.n !== n) { cache = _buildItemIndexMap(); justBuilt = true; }
    // 按 id 逐条比对 cache.refs：不碰宿主对象身份（失效对象做身份比较/取属性在 AE 里抛异常）。
    // 读 id 抛异常的单条跳过；refs 下标可能因项目重排而过期，命中后按当前下标复核 id 再返回。
    function indexById(id) {
        for (var k = 1; k <= cache.n; k++) {
            try {
                if (Math.floor(Number(cache.refs[k].id)) === id) {
                    if (Math.floor(Number(app.project.item(k).id)) === id) return k;
                }
            } catch (_) {}
        }
        return -1;
    }
    var targetId = 0;
    try { targetId = Math.floor(Number(target.id)); if (!(targetId > 0)) targetId = 0; } catch (_) { targetId = 0; }
    if (targetId > 0) {
        // 快路径：Item.id 直查 O(1)；非刚建表时复核该下标仍是同一对象，异常视为未命中
        var hit = cache.byId[targetId];
        if (hit !== undefined) {
            if (justBuilt) return hit;
            var same = false;
            try { same = (app.project.item(hit) === target); } catch (_) { same = false; }
            if (same) return hit;
        }
        // 兜底：按 id 逐条比对（不碰对象身份）；未命中即重建一次缓存，再按 id 查
        var byRefs = indexById(targetId);
        if (byRefs > 0) return byRefs;
        cache = _buildItemIndexMap();
        var hit2 = cache.byId[targetId];
        if (hit2 !== undefined) return hit2;
        return indexById(targetId);
    }
    // 目标无 id（旧版 AE）：只能按对象身份比对，逐条 try/catch——失效对象比较会抛异常
    for (var m = 1; m <= cache.n; m++) {
        try { if (cache.refs[m] === target) return m; } catch (_) {}
    }
    cache = _buildItemIndexMap();
    for (var p = 1; p <= cache.n; p++) {
        try { if (cache.refs[p] === target) return p; } catch (_) {}
    }
    return -1;
}

// 获取素材源类型（替代 src.typeName，typeName 在中文版 AE 上返回 GBK 乱码）。
// 返回英文常量：comp/footage/file/solid/placeholder/unknown
// - layer.source 是 CompItem 时返回 "comp"
// - 是 FootageItem 时按 mainSource 类型返回 "file"/"solid"/"placeholder"
function _getSourceKind(src) {
    if (!src) return 'unknown';
    try {
        if (src instanceof CompItem) return 'comp';
        if (src instanceof FootageItem) {
            var ms = src.mainSource;
            if (!ms) return 'footage';
            if (ms instanceof FileSource) return 'file';
            if (ms instanceof SolidSource) return 'solid';
            if (ms instanceof PlaceholderSource) return 'placeholder';
            return 'footage';
        }
    } catch (_) {}
    return 'unknown';
}

// 分页参数名检查：layer target 用 layerOffset/layerLimit，其他用 itemOffset/itemLimit。
// 传错参数静默忽略是 LLM 踩坑高发点，返回 warnings 数组供调用方附加到结果。
function _checkPagingArgs(target, args) {
    if (!args) return [];
    var warnings = [];
    // effect target 用 propertyOffset/propertyLimit（属性分页）；其余两族参数传入即提示被忽略
    if (target === 'effect') {
        if (args.itemOffset !== undefined || args.itemLimit !== undefined) {
            warnings.push('此 target 使用 propertyOffset/propertyLimit 分页，传入的 itemOffset/itemLimit 被忽略');
        }
        if (args.layerOffset !== undefined || args.layerLimit !== undefined) {
            warnings.push('此 target 使用 propertyOffset/propertyLimit 分页，传入的 layerOffset/layerLimit 被忽略');
        }
        return warnings;
    }
    var usesLayerPaging = (target === 'layers' || target === 'layer');
    var hasItemPaging = (args.itemOffset !== undefined || args.itemLimit !== undefined);
    var hasLayerPaging = (args.layerOffset !== undefined || args.layerLimit !== undefined);
    if (usesLayerPaging && hasItemPaging) {
        warnings.push('此 target 使用 layerOffset/layerLimit 分页，传入的 itemOffset/itemLimit 被忽略');
    }
    if (!usesLayerPaging && hasLayerPaging) {
        warnings.push('此 target 使用 itemOffset/itemLimit 分页，传入的 layerOffset/layerLimit 被忽略');
    }
    if (args.propertyOffset !== undefined || args.propertyLimit !== undefined) {
        warnings.push('此 target 不使用 propertyOffset/propertyLimit 分页（effect 专用），传入的被忽略');
    }
    return warnings;
}

// ── 参数形态校验 ────────────────────────────────────
// 列表参数判定：`typeof x.length !== "number"` 对字符串恒为假（字符串有 length），
// "940" 会被 for 循环逐字符拆成 9/4/0；数组才放行。ES3 没有可靠的跨 realm Array.isArray
// 保障（面板 JS 与 AE 宿主两个 realm），统一用 Object.prototype.toString。
function _isArrayValue(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
}

// fields 组选择解析：getLayerInfo / getSelectedDetails / getCompInfo 共用一份合法清单
//（三处各抄一份清单 + 各自校验，越界空页因此完全跳过校验）。
// 返回值：{ ok:true, fieldSet, all }——fieldSet=null 表示未传（沿用既有默认），all 表示 "*"；
// 或 { ok:false, message }。未知值点名并列出该 target 的完整清单（自描述，调用方不用猜）。
// 元素必须为字符串：数字/布尔这类形近值容易与组名混淆，直接报错而不是隐式 String()。
// kind: "layer" | "comp"；example 只用于形态错误文案里的示例（layer 用 transform、comp 用 base）。
function _parseFieldsArg(fields, kind, example) {
    if (fields === undefined || fields === null) return { ok: true, fieldSet: null, all: false };
    var allowed = (kind === "comp")
        ? ["base", "markers", "references", "timeline"]
        : ["base", "content", "transform", "timeRemap", "masks", "text",
           "textAnimators", "layerStyles", "effects", "shapeContents", "trackMatte",
           "timeMap", "frames", "markers", "references", "tree"];
    var shapeMsg = "fields 需为字符串数组（如 [\"" + example + "\"]）";
    if (!_isArrayValue(fields)) return { ok: false, message: shapeMsg };
    var set = {};
    var all = false;
    var bad = "";
    var badIndex = 0;
    for (var i = 0; i < fields.length; i++) {
        var v = fields[i];
        if (typeof v !== "string") {
            if (!badIndex) badIndex = i + 1;
            continue;
        }
        if (v === "*") { all = true; continue; }
        var known = false;
        for (var j = 0; j < allowed.length; j++) {
            if (allowed[j] === v) { known = true; break; }
        }
        if (!known && !bad) bad = v;
        set[v] = true;
    }
    if (badIndex) return { ok: false, message: shapeMsg + "：第 " + badIndex + " 项不是字符串" };
    if (bad) return { ok: false, message: "未知 field: " + bad + "；可用: " + allowed.join(", ") };
    return { ok: true, fieldSet: set, all: all };
}

// 图层详情（支持批量 layerIndex/layerIndices + layerName/layerType 过滤 + includeTree + references + markers + 分页）
function getLayerInfo(args) {
    try {
        args = args || {};
        // 内部参数隔离：`_` 前缀键是宿主内部接力用的（selected(timeline) 把
        // 整页共用的一份 _responseBudget 传给每层），不作公开参数。工具入口 queryDetails 已先
        // 剔除全部 `_` 前缀键，LLM 无法注入 {respUsed:-999999} 关掉 24000/12KB 门；这里再兜一层，
        // 只放行 _responseBudget 这一条内部接力通道，其余 `_` 键一律丢弃。
        var _cleanArgs = {};
        for (var _caK in args) {
            if (!Object.prototype.hasOwnProperty.call(args, _caK)) continue;
            if (_caK.charAt(0) === "_" && _caK !== "_responseBudget") continue;
            _cleanArgs[_caK] = args[_caK];
        }
        args = _cleanArgs;
        // 合成定位：与 target=comp / effect 共用 _resolveStrictComp——compositionId
        // 优先，其次 compositionIndex/compIndex；值必须 number 正整数，字符串/布尔/浮点/0/越界
        // 一律报错（旧路径 Number(true)→1、"1"→1、1.5→1 静默落到别的合成）。两个键都没给即
        // 报错，不回退活动合成。
        var _rc = _resolveStrictComp(args, false);
        if (_rc.error) return { status: "error", message: _rc.error };
        var comp = _rc.comp;
        var compIdx = _rc.compIdx;
        // fields 组选择：只决定"返回哪些块"，块内细节仍由下面的 include* 开关控制。
        // 未传 = 现有默认；"*" = 全量组；未知 field / 形态错误直接报错并列出合法清单（不静默忽略）。
        // 校验与清单在 _parseFieldsArg（selected(timeline) 同一入口，空页也照样校验）。
        // markers/references/tree 沿用既有开关语义：fields 里出现即等价开启。
        var _fieldsParsed = _parseFieldsArg(args.fields, "layer", "transform");
        if (!_fieldsParsed.ok) return { status: "error", message: _fieldsParsed.message };
        var _fieldSet = _fieldsParsed.fieldSet;
        var _fieldAll = _fieldsParsed.all;
        function _fieldOn(name) {
            if (_fieldSet === null) return false;
            if (_fieldAll) return true;
            return _fieldSet[name] === true;
        }
        var wantTree = _fieldSet === null ? (args.includeTree === true) : _fieldOn("tree");
        var wantRefs = _fieldSet === null ? (args.references === true) : _fieldOn("references");
        var wantMarkers = _fieldSet === null ? (args.markers === true) : _fieldOn("markers");
        // 响应级字节预算体：关键帧、形状内容、蒙版/效果载荷各一个计数，整页共用，
        // 耗尽时结果级置位。selected(timeline) 会把自己那份传进来（同页多层共用一份预算），
        // 其余入口本层新建。
        var _respBudget = (args._responseBudget && typeof args._responseBudget === "object")
            ? args._responseBudget
            : { kfUsed: 0, shapeUsed: 0, payloadUsed: 0, kfExhausted: false, shapeExhausted: false };
        if (typeof _respBudget.payloadUsed !== "number") _respBudget.payloadUsed = 0;
        // 响应级总预算计数：同一页多层共用，未传预算体时这里补 0
        if (typeof _respBudget.respUsed !== "number") _respBudget.respUsed = 0;
        // 详情深读开关：蒙版顶点默认只给数量（includeMaskVertices 才展开坐标）、
        // 文本动画器与图层样式默认给（includeTextAnimators/includeLayerStyles:false 可关）。
        // 形状内容树默认给骨架（includeShapeContents:false 可关，shapeNodeLimit 默认 200/上限 2000，
        // includeShapeValues:true 才读叶子值）。
        var detailOpts = {
            includeMaskVertices: args.includeMaskVertices === true,
            includeTextAnimators: args.includeTextAnimators !== false,
            includeLayerStyles: args.includeLayerStyles !== false,
            // 未启用样式的参数：opt-in（默认只给 enabled/index 骨架，置 paramsUnread）
            includeDisabledLayerStyleParams: args.includeDisabledLayerStyleParams === true,
            // 样式参数的动画：opt-in（默认只给 numKeys 与非空表达式，关键帧要显式开）
            includeLayerStyleAnimation: args.includeLayerStyleAnimation === true,
            includeShapeContents: args.includeShapeContents !== false,
            includeShapeValues: args.includeShapeValues === true,
            // 效果动画索引：opt-in；fields 不含 effects 时不返回（块级交集）
            includeEffectAnimation: args.includeEffectAnimation === true,
            shapeNodeLimit: args.shapeNodeLimit,
            // 关键帧窗口：layer/selected(timeline) 用，每属性一页
            //（默认 offset 0 / limit 30、上限 200）；形态校验在 _getSingleLayerDetail 内统一做
            keyframeOffset: args.keyframeOffset,
            keyframeLimit: args.keyframeLimit,
            // 逐属性 offset：对象键 = 输出字段前缀或 matchName；未点名回退标量
            keyframeOffsets: args.keyframeOffsets,
            // 蒙版/效果清单的分页与顶点上限：默认 0/20、上限 100；
            // 顶点坐标默认不展开（includeMaskVertices:true 才给），展开时上限 vertexLimit（默认 200、上限 2000）
            maskOffset: args.maskOffset,
            maskLimit: args.maskLimit,
            effectOffset: args.effectOffset,
            effectLimit: args.effectLimit,
            // 文本动画器窗口：默认 0/20、上限 100（_parsePaging 口径）；
            // 动画器另有 6000B 整层预算，超预算从尾部裁并置 textAnimatorsBytesTruncated。
            textAnimatorOffset: args.textAnimatorOffset,
            textAnimatorLimit: args.textAnimatorLimit,
            vertexLimit: args.vertexLimit,
            // 响应级字节预算体：同一页的多层共用一份（关键帧 12KB、形状内容 12KB、载荷 12KB，
            // 另加总预算 24000）
            _responseBudget: _respBudget,
            fields: _fieldSet === null ? undefined : (_fieldAll ? ["*"] : args.fields)
        };
        var paging = _parsePaging({ offset: args.layerOffset, limit: args.layerLimit }, 5, 10);
        var matchedIndices = [];
        // 稳定键优先：layerIds/layerId 先解析成 index（解析当刻的位置），任一 id 失效 → 整批报错。
        // 不返回半批：半批看起来像"就这些层"，会让人以为其余层不存在。
        var wantLayerIds = null;
        if (args.layerIds !== undefined && args.layerIds !== null) {
            // 形态：必须是数组（typeof .length !== "number" 会放过字符串，逐字符当 id 解析）
            if (!_isArrayValue(args.layerIds)) return { status: "error", message: "layerIds 需为数组" };
            wantLayerIds = args.layerIds;
        } else if (args.layerId !== undefined && args.layerId !== null) {
            wantLayerIds = [args.layerId];
        }
        if (wantLayerIds) {
            var idLabel = (args.layerIds !== undefined && args.layerIds !== null) ? "layerIds" : "layerId";
            // 形态/空数组/元素校验统一走 _resolveItemIds（公共 helper）：
            // 空数组不静默压过有效单值（`layerIds:[], layerIndex:2` 会返回 0 条）；元素仅
            // number 或纯数字字符串的正整数，布尔/数组/对象/浮点一律报错并点名第几项——若只
            // 走 Math.floor(Number(...))，true → 1、[804] → 804，把类型错误吞成「找不到 id」。
            var _lidParsed = _resolveItemIds(wantLayerIds, idLabel);
            if (_lidParsed.error) return { status: "error", message: _lidParsed.error };
            var missingIds = [];
            for (var k = 0; k < _lidParsed.ids.length; k++) {
                var lid = _lidParsed.ids[k];
                var byIdLayer = _findLayerById(comp, lid);
                if (!byIdLayer) { missingIds.push(String(lid)); continue; }
                matchedIndices.push(byIdLayer.index);
            }
            if (missingIds.length > 0) {
                return { status: "error", message: "图层 id 找不到（可能已删除或不在合成 \"" + comp.name + "\" 内）: " + missingIds.join(", ") };
            }
        } else if (args.layerIndices !== undefined && args.layerIndices !== null) {
            // 形态与值域校验：若只判 args.layerIndices 真值再按
            // .length 遍历，字符串 "12" 被逐字符拆成 [1,2]（返回 1 条却 totalCount=2，静默半批）。
            // 现在非数组报错，元素必须是 1..numLayers 的正整数，任一无效/越界即整批报错
            //（口径对齐 layerIds：不返回半批，半批看起来像「其余层不存在」）。
            if (!_isArrayValue(args.layerIndices)) return { status: "error", message: "layerIndices 需为数组" };
            if (args.layerIndices.length === 0) {
                return { status: "error", message: "layerIndices 不能为空数组；查看全部图层请用 queryProject(target=layers)" };
            }
            for (var lix = 0; lix < args.layerIndices.length; lix++) {
                var liRaw = args.layerIndices[lix];
                var li = (typeof liRaw === "number") ? liRaw : NaN;
                if (!isFinite(li) || li !== Math.floor(li) || li < 1) {
                    return { status: "error", message: "layerIndices 第 " + (lix + 1) + " 项不是正整数索引: " + String(liRaw) };
                }
                if (li > comp.numLayers) {
                    return { status: "error", message: "layerIndices 第 " + (lix + 1) + " 项越界: " + li + "（本合成图层数 " + comp.numLayers + "）" };
                }
                matchedIndices.push(li);
            }
        } else if (args.layerIndex !== undefined && args.layerIndex !== null) {
            // 单值复用 *Indices 的同一套校验：若用 `Number(...)` + isNaN
            // 会把 99（越界）、0、'abc' 之外的整数静默塞进匹配列表，越界后循环 continue，
            // 最终 success/totalCount=1/count=0（数组同值却整批报错）。
            var liRawSingle = args.layerIndex;
            var liSingle = (typeof liRawSingle === "number") ? liRawSingle : NaN;
            if (!isFinite(liSingle) || liSingle !== Math.floor(liSingle) || liSingle < 1) {
                return { status: "error", message: "layerIndex 不是正整数索引: " + String(liRawSingle) };
            }
            if (liSingle > comp.numLayers) {
                return { status: "error", message: "layerIndex 越界: " + liSingle + "（本合成图层数 " + comp.numLayers + "）" };
            }
            matchedIndices.push(liSingle);
        } else if (args.layerName || args.layerType) {
            var filterName = args.layerName ? String(args.layerName).toLowerCase() : '';
            var filterType = args.layerType ? String(args.layerType).toLowerCase() : '';
            for (var j = 1; j <= comp.numLayers; j++) {
                var layer = comp.layer(j);
                var lt = _getLayerType(layer);
                if (filterType && lt !== filterType) continue;
                if (filterName) { var lname = ''; try { lname = String(layer.name).toLowerCase(); } catch (_) {} if (lname.indexOf(filterName) < 0) continue; }
                matchedIndices.push(layer.index);
            }
        } else {
            // 无任何过滤条件：layer target 必填「至少一个过滤条件」
            return { status: "error", message: "需要至少一个过滤条件：layerId / layerIds / layerIndex / layerIndices / layerName / layerType。查看全部图层请用 queryProject(target=layers)" };
        }
        var totalCount = matchedIndices.length;
        var startIdx = paging.offset;
        var endIdx = paging.offset + paging.limit;
        if (startIdx > totalCount) startIdx = totalCount;
        if (endIdx > totalCount) endIdx = totalCount;
        var pagedIndices = matchedIndices.slice(startIdx, endIdx);
        // references 对同一 comp 的所有图层结果相同，提到循环外计算一次
        var sharedRefs = null;
        var refsTruncated = false;
        var _refsBytes = 0;
        if (wantRefs) {
            var refResult = _findSourceRefs(comp);
            sharedRefs = refResult.refs;
            refsTruncated = refResult.truncated;
            try { _refsBytes = JSON.stringify(sharedRefs).length; } catch (_) { _refsBytes = 0; }
        }
        var layers = [];
        for (var pi = 0; pi < pagedIndices.length; pi++) {
            var layerIdx = pagedIndices[pi];
            if (layerIdx < 1 || layerIdx > comp.numLayers) continue;
            var layer = comp.layer(layerIdx);
            var info = _getSingleLayerDetail(layer, comp, detailOpts);
            // 多图层页共用一个 maskOffset/effectOffset，但各层 nextMaskOffset 不同：
            // 本层还有未返回条目时给提示，续读请改用 layerIndices/单层查询。
            // 被预算饿死（0 条 + starved）同样是"本层还有内容、本页取不到"，
            // 一并给 multiLayerPagination，避免调用方按 nextMaskOffset 原地重试。
            if (pagedIndices.length > 1 && (info.masksHasMore === true || info.effectsHasMore === true
                || info.textAnimatorsHasMore === true
                || info.masksStarved === true || info.effectsStarved === true
                || info.textAnimatorsStarved === true)) {
                info.multiLayerPagination = true;
            }
            if (wantMarkers) {
                // 标记单层上限 100（_getLayerMarkers），字节按实际 JSON 计入
                // 响应级 24000 总预算；剩余额度装不下时从尾部继续裁（多层同页各层标记是独立数组，
                // 裁剪不会互相影响），置 markersTruncated + markersTotal（真实条数）。
                // 薄数据（0/少数标记且额度充足）不产生额外字段。
                var _mkState = {};
                info.markers = _getLayerMarkers(layer, _mkState);
                var _mkTrueTotal = (typeof _mkState.total === "number") ? _mkState.total : null;
                if (_mkState.truncated) info.markersTruncated = true;
                if (_isArrayValue(info.markers) && info.markers.length > 0) {
                    var _mkRemain = -1;
                    try {
                        if (typeof _respBudget.respRemain === "function") _mkRemain = _respBudget.respRemain();
                    } catch (_) { _mkRemain = -1; }
                    var _mkBytes = 0;
                    try { _mkBytes = JSON.stringify(info.markers).length; } catch (_) { _mkBytes = 0; }
                    while (_mkRemain >= 0 && info.markers.length > 0 && _mkBytes > _mkRemain) {
                        info.markers.pop();
                        info.markersTruncated = true;
                        try {
                            _mkBytes = (info.markers.length > 0) ? JSON.stringify(info.markers).length : 2;
                        } catch (_) { _mkBytes = 0; }
                    }
                    try { if (typeof _respBudget.respCharge === "function") _respBudget.respCharge(_mkBytes); } catch (_) {}
                }
                if (info.markersTruncated && _mkTrueTotal !== null) info.markersTotal = _mkTrueTotal;
            }
            if (wantRefs) {
                info.references = sharedRefs;
                if (refsTruncated) info.referencesTruncated = true;
                // references 对同 comp 各层是同一个数组（JSON 按层重复一遍），
                // 条数上限 200 已在 _findSourceRefs（maxBreadth=200）；这里按层计入响应级总预算，
                // 免得多层同页把响应撑过 28KB。
                if (_refsBytes > 0) {
                    try { if (typeof _respBudget.respCharge === "function") _respBudget.respCharge(_refsBytes); } catch (_) {}
                }
            }
            layers.push(info);
        }
        var layerTree = null;
        if (wantTree && pagedIndices.length > 0) layerTree = _buildLayerTreeForMatches(comp, pagedIndices);
        var result = {
            status: "success", compositionIndex: compIdx, compName: comp.name,
            layers: layers, count: layers.length, totalCount: totalCount,
            layerOffset: paging.offset, layerLimit: paging.limit,
            hasMore: (paging.offset + paging.limit) < totalCount
        };
        if (wantTree) result.layerTree = layerTree;
        // warnings 与未知 keyframeOffsets 键先装进结果：_enforceResponse 的
        // extraBytes 按 result 实际长度算，warnings 的字节因此并入兜底额度——若先兜底、
        // 再把 warnings 追加到结果，warnings 文本可能把响应重新顶过 26000。
        var _layerWarns = _checkPagingArgs('layer', args);
        if (_layerWarns.length > 0) result.warnings = _layerWarns;
        // 未知 keyframeOffsets 键回显：结果级一次，无则不出现。
        if (_isArrayValue(_respBudget.kfOffsetsIgnored) && _respBudget.kfOffsetsIgnored.length > 0) {
            result.keyframeOffsetsIgnored = _respBudget.kfOffsetsIgnored;
        }
        // 预算耗尽：结果级如实标注——层级标记在每层的 keyframesBudgetExhausted /
        // shapeBytesTruncated / masksTruncated+effectsTruncated+payloadBytesTruncated 上；
        // 关键帧续页用该属性的 keyframesOffset + 实际条数，蒙版/效果续页用 nextMaskOffset/nextEffectOffset。
        // 形状截断只置 shapeBytesTruncated，不置 keyframesBudgetExhausted（形状叶子键不计关键帧预算）。
        if (_respBudget.kfExhausted) result.keyframesBudgetExhausted = true;
        if (_respBudget.shapeExhausted) result.shapeBytesTruncated = true;
        if (_respBudget.payloadExhausted) result.payloadBytesTruncated = true;
        // 响应级总预算：所有分项都计入 24000；固定字段（每层 base/transform
        // 静态值等）不计入，结果组装时再按 JSON 长度兜底（载荷 → 形状 → 关键帧），保证最终
        // JSON ≤约 28KB。真发生收缩时层级/结果级都置 responseBytesTruncated，分项标记同步。
        if (layers.length > 0 && typeof _respBudget.enforceResponse === "function") {
            var _respWrapBytes = 0;
            try { _respWrapBytes = JSON.stringify(result).length - JSON.stringify(layers).length; } catch (_) { _respWrapBytes = 400; }
            if (!(_respWrapBytes > 0)) _respWrapBytes = 400;
            if (_respBudget.enforceResponse(layers, _respWrapBytes)) result.responseBytesTruncated = true;
        }
        if (_respBudget.respExhausted) result.responseBytesTruncated = true;
        for (var _rl = 0; _rl < layers.length; _rl++) {
            if (layers[_rl].keyframesBudgetExhausted) result.keyframesBudgetExhausted = true;
            if (layers[_rl].shapeBytesTruncated) result.shapeBytesTruncated = true;
            if (layers[_rl].payloadBytesTruncated) result.payloadBytesTruncated = true;
            if (layers[_rl].responseBytesTruncated) result.responseBytesTruncated = true;
            // 兜底阶段才被裁空的层同样补多图层续读提示（构建期只能看到分项预算）
            // textAnimators 兜底裁空与 masks/effects 同一语义，一并补提示。
            if (layers.length > 1 && (layers[_rl].masksStarved === true || layers[_rl].effectsStarved === true
                || layers[_rl].textAnimatorsStarved === true)) {
                layers[_rl].multiLayerPagination = true;
            }
        }
        return result;
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}



function createTextLayer(args) {
    try {
        var comp = getCompOrThrow(args);
        var text = args.text || "Text Layer";
        var position = args.position || [comp.width / 2, comp.height / 2];
        var fontSize = Number(args.fontSize) || 72;
        var color = args.color || [1, 1, 1];
        var startTime = Number(args.startTime) || 0;
        var duration = args.duration !== undefined ? Number(args.duration) : comp.duration;
        var fontFamily = args.fontFamily || "Arial";
        var alignment = args.alignment || "center";
        var textLayer = comp.layers.addText(text);
        var textProp = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
        var textDoc = textProp.value;
        textDoc.fontSize = fontSize;
        textDoc.fillColor = color;
        textDoc.font = fontFamily;
        if (alignment === "left") textDoc.justification = ParagraphJustification.LEFT_JUSTIFY;
        else if (alignment === "center") textDoc.justification = ParagraphJustification.CENTER_JUSTIFY;
        else if (alignment === "right") textDoc.justification = ParagraphJustification.RIGHT_JUSTIFY;
        textProp.setValue(textDoc);
        try { var posPropT = getPropSafe(textLayer, "Position"); if (posPropT) posPropT.setValue(position); } catch (e) {}
        textLayer.startTime = startTime;
        if (duration > 0) textLayer.outPoint = startTime + duration;
        return { status: "success", message: "Text layer created", layer: { index: textLayer.index, name: textLayer.name, inPoint: textLayer.inPoint, outPoint: textLayer.outPoint } };
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

function applyPreset(args) {
    try {
        var target = getLayerTarget(args);
        var layer = target.layer;
        var presetPath = args.presetPath || args.path || "";
        if (!presetPath) throw new Error("Must provide presetPath (absolute path to .ffx file)");
        if (!_checkPath(presetPath)) throw new Error("Invalid or unsafe path: " + presetPath);
        if (_isSensitivePath(presetPath)) throw new Error("敏感路径，已拒读: " + presetPath);
        var presetFile = new File(presetPath);
        if (!presetFile.exists) throw new Error("Preset file not found: " + presetPath);
        // layer.applyPreset 实际作用于"当前选中的所有层"（未文档化行为，见 presetApi.jsx 头注释）。
        // 若用户选着 A/B/C 三层而本函数只定位到 B，直接调用会把预设应用到全部三层。
        // 因此先快照并清空选区、仅选中目标层，应用后恢复原选区（与 presetApi 的分块路径同款写法）。
        // comp.selection = null 在 CEP evalScript 下不可靠，用 selectedLayers 逐层清。
        var comp = target.comp;
        var prevSel = [];
        try {
            var sl = comp.selectedLayers;
            for (var i = 0; i < sl.length; i++) prevSel.push(sl[i]);
            for (var k = 0; k < sl.length; k++) { try { sl[k].selected = false; } catch (_) {} }
        } catch (_) {}
        layer.selected = true;
        try {
            layer.applyPreset(presetFile);
        } finally {
            // 恢复原选区（本函数不动用户选区约定）
            try { layer.selected = false; } catch (_) {}
            for (var r = 0; r < prevSel.length; r++) { try { prevSel[r].selected = true; } catch (_) {} }
        }
        return { status: "success", message: "Preset applied: " + presetPath, layer: { index: layer.index, name: layer.name } };
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}


// —— 授权帧（沙箱逃逸根因修复）——
// 授权位不从**调用方传进来的 args** 读：这些字段（args.__allow / args.__undoName /
// args.__dataDir），authored 代码自造一个同名字段递归调用核即可让守卫换成「授权」形态
//（AE 内实测逃逸：file:false 时 new File 构造从 THREW 变 OK；__dataDir 伪造 = 可控
// 路径写盘）。现改为：面板在 authored 代码执行**之前**用随机令牌建立授权帧、末尾关闭，
// 核与消费点读帧；令牌只出现在面板拼装的脚本文本里、不进 args（authored 代码读不到
// 拼装文本 → 猜不到令牌）。
//
// 本文件整体包进 IIFE，顶层名默认不再落到 ExtendScript 全局；帧本体
// 改为闭包私有 _authFrame，**只导出委托门面** __aeSAuth（begin/end/get 三者转发）：
// authored 代码按名可达的只有门面，替换门面 ⇒ begin 从未被调 ⇒ 帧从未建立 ⇒ 核与
// 消费点读到全 false 空帧 ⇒ 全拒（fail-closed，不是全开）。
// 闭包内的 _depth/_frame/_token 在闭包作用域里，authored 代码只能经门外 begin/end
// 且必须带令牌：
//   · 帧内重入（_depth > 0）的 begin 只在**同一令牌**下计数，否则拒——嵌套调用/自造
//     begin 无法顶替已开帧的载荷，也无法靠伪造令牌提前开新帧；
//   · 被拒的 begin 不计数（否则一次 end 关不掉本帧，帧永久残留）；
//   · end 同样校验令牌——否则帧内可先 end 再 begin 伪造；
//   · 成对嵌套：N 次 begin(同令牌) 需 N 次 end(同令牌) 才清空。
// get() **每次返回新建的快照**（无帧时同样是新建的空快照，不共享单例）：fail-closed
// 缺省下四域皆非 true，保证各消费点的空值语义与既有实现一致（核的 _allow 恒为对象、
// 撤销组名恒为字符串、dataDir 走既有回落）。
// 为什么必须快照、不能返回 _frame 本体/共享 EMPTY：get() 的返回值会被 **authored 代码
// 触达**（核与 getPreviewFrame 读它，且用户代码与该读取同作用域）——交出活引用等于
// 把帧的**写权限**一并给出去：帧内 `get().allow.file = true` 可顶替本帧授权（后续
// 嵌套调核读到被改的授权）；帧外改共享单例则**持久 fail-open**（此后任何无帧通道都
// 读到被写脏的授权位）。故 allow 亦逐键拷贝（四个布尔值归一为 true/false），
// undoName/dataDir 是字符串（值拷贝天然安全）。
// 注意 begin 的令牌不是密码学随机——它只是「authored 代码读不到拼装文本」的结果；
// ES3 同 VM 内不存在形式化保证。
// var 名 _authFrame（私有，不导出）——
// 拼装模板经导出门面调 begin/end；核与 getPreviewFrame 直接读 _authFrame。
var _authFrame = (function () {
    var _depth = 0, _frame = null, _token = null;
    function begin(token, payload) {
        if (_depth > 0) {
            if (token !== _token) return false;            // 帧内重入：只认同一令牌
        } else {
            _token = token;
            var p = (payload && typeof payload === 'object') ? payload : {};
            _frame = {
                allow: (p.allow && typeof p.allow === 'object') ? p.allow : {},
                undoName: (typeof p.undoName === 'string') ? p.undoName : '',
                dataDir: (typeof p.dataDir === 'string') ? p.dataDir : '',
                // **模板窗口标记**。只有面板拼装模板
                // （bootstrap.js 的 begin 载荷）会传 win:true，它表示「本帧 = 一次
                // authored 代码执行窗口，窗口内运行时守卫不得被拆」。载荷其余字段
                // 一律来自面板拼装，authored 代码既猜不到令牌、也无法在帧内重开帧
                // （不同令牌的 begin 被拒），故 win 不可被授权代码置位或清除。
                win: (p.win === true)
            };
        }
        _depth++;
        return true;
    }
    function end(token) {
        if (_depth > 0 && token === _token) {
            _depth--;
            if (_depth === 0) { _frame = null; _token = null; }
        }
    }
    function get() {
        var f = _frame;
        if (!f) return { allow: {}, undoName: '', dataDir: '' };   // 每次新建——见上方「为什么必须快照」
        var a = f.allow || {};
        return {
            allow: {
                system: a.system === true, socket: a.socket === true,
                file: a.file === true, dialog: a.dialog === true
            },
            undoName: f.undoName, dataDir: f.dataDir
        };
    }
    // 模板窗口查询（**私有**：不经 __aeSAuth 门面转发——authored 代码读不到本方法，
    // 也就无法据此判断/影响窗口状态；门面仍只有 begin/end/get 三件，见导出块）
    function win() {
        return !!(_frame && _frame.win === true);
    }
    return { begin: begin, end: end, get: get, win: win };
})();


// ============================================================================
// 守卫闭包私有化：运行时防护安装/卸载入口 __aeSGOn / __aeSGDn
// 原 bootstrap.js 拼装模板的三段字符串 JS（sandboxBlock / fileGuardOpen /
// fileGuardClosed，三份实现各抄一份）整体下沉至此；判据 _isSensitivePath /
// _isSystemOrRootDir 在闭包内**词法引用**——授权代码的名字空间里没有名字可换。
// 语义逐条对齐原模板（消息文案逐字一致）：
//   宿主 shadow：system.callSystem / Socket 按域（allow.system / allow.socket）、
//     BridgeTalk / app.scheduleTask 恒拒（硬拒项无能力域开关）、恢复含
//     $.global.Socket 双写同步；
//   File/Folder 原型补丁两 profile——
//     未授权（allow.file !== true）：open 写模式（/^[a-z+]*$/ 且含 w/a/e）与
//       remove/rename/copy/create/execute/changePath 全抛；
//     授权（allow.file === true）：敏感路径 open 读写两态都抛；写/删方向
//       （open 写模式 / remove / rename / copy / create）加系统目录/盘根判据
//       （rename/copy 连查目标参数 arguments[0]）；execute/changePath 恒拒。
// 重入：深度计数——已安装时只加计数、不重复保存；归零才恢复并清空保存引用
//（不留常驻引用）。成功返回**严格 true**——模板 `!== true` 即中止本次调用（I5）。
// allow 从私有帧 _authFrame 读（入口无参——面板/模板无法按名传授权值）。
// ============================================================================
var _guard = { depth: 0, fproto: null, dproto: null, fsave: null, dsave: null,
               saveCS: null, saveBT: null, saveSK: null, saveST: null,
               hasCS: false, hasBT: false, hasSK: false, hasST: false };

// ── 守卫原始引用跨模块实例持久化 ──
// 原型补丁的生存期与模块实例绑定：模块被重新求值后，新实例的 _guard 深度为 0、原始
// 引用丢失，旧补丁无法卸载，File/Folder 原型会一直处于拦截态，启动期的文件写被拒导致
// 面板无法完成加载。安装时把原始引用挂到**真实 File 构造函数**（不用 $.global）：授权
// 代码执行期间 File 标识符与 $.global.File 均指向 shadow 函数，真构造函数不可达，槽
// 不作为沙箱能力入口；模块重新求值在窗口之外，可直接读到该槽还原。
var _GUARD_SLOT = "__aeSGPersist";
var _guardSlotHost = (typeof File !== "undefined" && File) ? File : null;
var _persistGuard = function (g) {
    try { if (_guardSlotHost) { _guardSlotHost[_GUARD_SLOT] = g; } } catch (_) {}
};
var _clearPersistedGuard = function () {
    try { if (_guardSlotHost) { _guardSlotHost[_GUARD_SLOT] = null; } } catch (_) {}
};
var _recoverLeakedGuard = function () {
    try {
        if (!_guardSlotHost) return false;
        var s = _guardSlotHost[_GUARD_SLOT];
        if (!s) return false;
        var restored = false;
        var fp = (typeof File !== "undefined" && File && File.prototype) ? File.prototype : null;
        if (fp && s.fsave && fp.open !== s.fsave.open) {
            fp.open = s.fsave.open; fp.remove = s.fsave.remove;
            fp.rename = s.fsave.rename; fp.copy = s.fsave.copy;
            fp.execute = s.fsave.execute; fp.changePath = s.fsave.changePath;
            restored = true;
        }
        var dp = (typeof Folder !== "undefined" && Folder && Folder.prototype) ? Folder.prototype : null;
        if (dp && s.dsave) {
            dp.create = s.dsave.create; dp.remove = s.dsave.remove;
            dp.rename = s.dsave.rename;
            if (typeof s.dsave.copy === "function") dp.copy = s.dsave.copy;
            dp.execute = s.dsave.execute; dp.changePath = s.dsave.changePath;
            restored = true;
        }
        if (s.hasCS && s.saveCS && typeof system !== "undefined" && system
            && system.callSystem !== s.saveCS) {
            system.callSystem = s.saveCS;
            restored = true;
        }
        if (s.hasST && s.saveST && typeof app !== "undefined" && app
            && app.scheduleTask !== s.saveST) {
            app.scheduleTask = s.saveST;
            restored = true;
        }
        if (s.hasBT && s.saveBT && typeof BridgeTalk !== "undefined" && BridgeTalk !== s.saveBT) {
            BridgeTalk = s.saveBT;
            restored = true;
        }
        if (s.hasSK && s.saveSK) {
            if (typeof Socket !== "undefined" && Socket !== s.saveSK) {
                Socket = s.saveSK;
                restored = true;
            }
            if (typeof $ !== "undefined" && $.global && $.global.Socket !== s.saveSK) {
                $.global.Socket = s.saveSK;
                restored = true;
            }
        }
        if (restored) { _guardSlotHost[_GUARD_SLOT] = null; }
        return restored;
    } catch (_) { return false; }
};
// 模块求值即自检：存在残留补丁则先还原（无残留时为 no-op）。
_recoverLeakedGuard();

function __aeSGOn() {
    var g = _guard;
    if (g.depth > 0) { g.depth++; return true; }   // 嵌套窗口：只加计数，不重复保存
    var allow = _authFrame.get().allow || {};

    // 判据**值捕获**（实测：ExtendScript 的 new Function 泄漏作用域链，模块/
    // 内核作用域的绑定可被授权代码按字面标识符改写）。捕获发生在本 activation——它不在
    // 授权代码的作用域链上，故安装后的补丁读到的是捕获值：即便文本黑名单出现缺口、
    // 模块绑定被改写，本窗口内的原型补丁仍按真判据工作（纵深第二层）。
    var sensFn = _isSensitivePath, sysFn = _isSystemOrRootDir;

    var fproto = (typeof File !== "undefined" && File && File.prototype) ? File.prototype : null;
    var dproto = (typeof Folder !== "undefined" && Folder && Folder.prototype) ? Folder.prototype : null;
    var fsave = fproto ? { open: fproto.open, remove: fproto.remove, rename: fproto.rename,
                           copy: fproto.copy, execute: fproto.execute, changePath: fproto.changePath } : null;
    var dsave = dproto ? { create: dproto.create, remove: dproto.remove, rename: dproto.rename,
                           copy: dproto.copy, execute: dproto.execute, changePath: dproto.changePath } : null;

    // 原始引用捕获后立即持久化：后续任一原型赋值抛错时仍有完整恢复依据
    g.fproto = fproto; g.dproto = dproto; g.fsave = fsave; g.dsave = dsave;
    _persistGuard(g);

    // 敏感/系统目录判据（原模板的 __aeS* 拷贝）——闭包内词法引用单点，
    // 不再有「谓词缺席」分支（原模板的 typeof 探测 + fail-closed 拷贝随下沉消失）
    var sens = function (o) {
        var p = o ? String(o.fsName || o.absoluteURI || o.path || "") : "";
        return p ? !!sensFn(p) : false;
    };
    var pathOf = function (x) {
        return (x && typeof x === "object") ? String(x.fsName || x.absoluteURI || x.path || "") : String(x == null ? "" : x);
    };
    var sysDir = function (x) { return !!sysFn(pathOf(x)); };

    if (fproto) {
        if (allow.file === true) {
            fproto.open = function (m) {
                if (sens(this)) throw Error("[AE_LLM] File open blocked — 敏感路径（file 域授权不豁免敏感路径黑名单）");
                if (m != null) {
                    var s = String(m).toLowerCase();
                    if (/^[a-z+]*$/.test(s) && /[wea]/.test(s) && sysDir(this)) throw Error("[AE_LLM] File write blocked — 目标位于系统目录/盘根（system_dir，与 writeFile 同口径；file 域授权不豁免）");
                }
                return fsave.open.apply(this, arguments);
            };
            fproto.remove = function () {
                if (sens(this)) throw Error("[AE_LLM] File delete blocked — 敏感路径");
                if (sysDir(this)) throw Error("[AE_LLM] File delete blocked — 目标位于系统目录/盘根（system_dir，与 writeFile 同口径；file 域授权不豁免）");
                return fsave.remove.apply(this, arguments);
            };
            fproto.rename = function () {
                if (sens(this)) throw Error("[AE_LLM] File rename blocked — 敏感路径");
                if (sysDir(this) || sysDir(arguments[0])) throw Error("[AE_LLM] File rename blocked — 目标位于系统目录/盘根（system_dir，与 writeFile 同口径；file 域授权不豁免）");
                return fsave.rename.apply(this, arguments);
            };
            fproto.copy = function () {
                if (sens(this)) throw Error("[AE_LLM] File copy blocked — 敏感路径");
                if (sysDir(this) || sysDir(arguments[0])) throw Error("[AE_LLM] File copy blocked — 目标位于系统目录/盘根（system_dir，与 writeFile 同口径；file 域授权不豁免）");
                return fsave.copy.apply(this, arguments);
            };
            fproto.execute = function () { throw Error("[AE_LLM] File execute blocked in AE tool sandbox — hard-denied（无能力域开关）"); };
            fproto.changePath = function () { throw Error("[AE_LLM] changePath blocked in AE tool sandbox — hard-denied（无能力域开关）"); };
        } else {
            fproto.open = function (m) {
                if (m == null) return fsave.open.apply(this, arguments);
                var s = String(m).toLowerCase();
                if (/^[a-z+]*$/.test(s) && /[wea]/.test(s)) throw Error("[AE_LLM] File write blocked in AE tool sandbox — use readFile/writeFile tools instead");
                return fsave.open.apply(this, arguments);
            };
            fproto.remove = function () { throw Error("[AE_LLM] File delete blocked in AE tool sandbox — use readFile/writeFile tools instead"); };
            fproto.rename = function () { throw Error("[AE_LLM] File rename blocked in AE tool sandbox"); };
            fproto.copy = function () { throw Error("[AE_LLM] File copy blocked in AE tool sandbox"); };
            fproto.execute = function () { throw Error("[AE_LLM] File execute blocked in AE tool sandbox"); };
            fproto.changePath = function () { throw Error("[AE_LLM] changePath blocked in AE tool sandbox — real-instance re-pointing is a sensitive-read channel"); };
        }
    }
    if (dproto) {
        if (allow.file === true) {
            dproto.create = function () {
                if (sens(this)) throw Error("[AE_LLM] Folder create blocked — 敏感路径");
                if (sysDir(this)) throw Error("[AE_LLM] Folder create blocked — 目标位于系统目录/盘根（system_dir，与 writeFile 同口径；file 域授权不豁免）");
                return dsave.create.apply(this, arguments);
            };
            dproto.remove = function () {
                if (sens(this)) throw Error("[AE_LLM] Folder delete blocked — 敏感路径");
                if (sysDir(this)) throw Error("[AE_LLM] Folder delete blocked — 目标位于系统目录/盘根（system_dir，与 writeFile 同口径；file 域授权不豁免）");
                return dsave.remove.apply(this, arguments);
            };
            dproto.rename = function () {
                if (sens(this)) throw Error("[AE_LLM] Folder rename blocked — 敏感路径");
                if (sysDir(this) || sysDir(arguments[0])) throw Error("[AE_LLM] Folder rename blocked — 目标位于系统目录/盘根（system_dir，与 writeFile 同口径；file 域授权不豁免）");
                return dsave.rename.apply(this, arguments);
            };
            // copy 槽对齐内核 __aelPW（typeof 守卫——存在即守、不存在
            // 不动）。AE 的 Folder 目前无 copy（AST 表 FolderObj 未收录；同源核对见
            // tables.js），故此槽当前为 no-op——收口
            // 「dispatcher 侧无 copy 槽 / 内核 __aelPW 有」两实现槽位不一致。
            if (typeof dproto.copy === "function") {
                dproto.copy = function () {
                    if (sens(this)) throw Error("[AE_LLM] Folder copy blocked — 敏感路径");
                    if (sysDir(this) || sysDir(arguments[0])) throw Error("[AE_LLM] Folder copy blocked — 目标位于系统目录/盘根（system_dir，与 writeFile 同口径；file 域授权不豁免）");
                    return dsave.copy.apply(this, arguments);
                };
            }
            dproto.execute = function () { throw Error("[AE_LLM] Folder execute blocked in AE tool sandbox — hard-denied（无能力域开关）"); };
            dproto.changePath = function () { throw Error("[AE_LLM] changePath blocked in AE tool sandbox — hard-denied（无能力域开关）"); };
        } else {
            dproto.create = function () { throw Error("[AE_LLM] Folder create blocked in AE tool sandbox"); };
            dproto.remove = function () { throw Error("[AE_LLM] Folder delete blocked in AE tool sandbox"); };
            dproto.rename = function () { throw Error("[AE_LLM] Folder rename blocked in AE tool sandbox"); };
            if (typeof dproto.copy === "function") { dproto.copy = function () { throw Error("[AE_LLM] Folder copy blocked in AE tool sandbox"); }; }
            dproto.execute = function () { throw Error("[AE_LLM] Folder execute blocked in AE tool sandbox"); };
            dproto.changePath = function () { throw Error("[AE_LLM] changePath blocked in AE tool sandbox — real-instance re-pointing is a sensitive-read channel"); };
        }
    }

    // —— 宿主 shadow（按名取用的一律 typeof 守卫：vm/单测环境可无这些对象）——
    if (typeof system !== "undefined" && system && typeof system.callSystem === "function" && allow.system !== true) {
        g.saveCS = system.callSystem;
        g.hasCS = true;
        system.callSystem = function () { throw Error("[AE_LLM] System call blocked — enable in Agent 模块设置 > AST 门能力配置"); };
    }
    if (typeof BridgeTalk !== "undefined") {
        g.saveBT = BridgeTalk;
        g.hasBT = true;
        BridgeTalk = function () { throw Error("[AE_LLM] BridgeTalk blocked — 硬拒项（无能力域开关）"); };
    }
    if (typeof Socket !== "undefined" && allow.socket !== true) {
        g.saveSK = Socket;
        g.hasSK = true;
        Socket = function () { throw Error("[AE_LLM] Socket blocked — enable in Agent 模块设置 > AST 门能力配置"); };
    }
    if (typeof app !== "undefined" && app && typeof app.scheduleTask === "function") {
        g.saveST = app.scheduleTask;
        g.hasST = true;
        app.scheduleTask = function () { throw Error("[AE_LLM] scheduleTask blocked — 硬拒项（无能力域开关）"); };
    }

    g.depth = 1;
    return true;
}

function __aeSGDn() {
    var g = _guard;
    if (g.depth <= 0) return;
    // 守卫可被「计算名 + 内核嵌套调用」拆除——
    // **模板窗口内拒绝拆守卫**（含 depth 1→0 这一步）。
    // 缺口：__aeSGOn/__aeSGDn 是导出到 $.global 的普通可写属性，而 authored 代码
    // 恰好跑在 armed 窗口内（bootstrap 模板：begin → On → 用户代码 → Dn → end）⇒
    // 用户代码 `this["__ae"+"SGDn"]()`（或裸 __aeSGDn()）一把就把 depth 降到 0，
    // 本函数随即把 system.callSystem / Socket / app.scheduleTask / File.prototype
    // 全还原成真函数 ⇒ 能力域全关也能起进程（两路独立复现：真 harness 125/125、
    // 135/135）。
    // 判据为什么用「帧载荷的 win 标记」而不是「帧是否打开」：帧是唯一**令牌保护**
    // 的通道（authored 代码猜不到令牌 ⇒ 既不能开新帧、也不能提前 end），故「win 帧
    // 开着」= 「模板窗口未结束」是授权代码**无法伪造/清除**的状态；而只看「帧打开」
    // 会误伤直接驱动守卫的既有调用方（
    // 先 begin(无 win) 再 __aeSGDn()——那是既有契约，必须保持可用）。
    // 为什么只在 depth===1 拦：嵌套窗口（用户代码又触发一次模板调用）在 depth≥2
    // 卸载是**正常路径**——它只把计数降回 1，守卫仍在（本函数只在归零时还原）；
    // 真正的危险只有 1→0 那一步。攻击者在窗口内哪怕反复调用，也只会把计数降到 1
    // 为止，永远到不了 0（后续调用全部命中本行被拒）。
    // 模板侧配套（bootstrap.js，两处）：begin 载荷带 win:true；且 **end 提到本函数
    // 之前**（帧先关、win 归 false，模板自己的卸载才被放行）——顺序反了会让模板自己
    // 卸不掉守卫（守卫永久驻留：之后每次调用都重复补丁，readFile/writeFile 连锁失效）。
    if (g.depth === 1 && _authFrame.win()) return;
    g.depth--;
    if (g.depth !== 0) return;                    // 仍有嵌套窗口：不提前恢复
    if (g.fsave && g.fproto) {
        g.fproto.open = g.fsave.open; g.fproto.remove = g.fsave.remove;
        g.fproto.rename = g.fsave.rename; g.fproto.copy = g.fsave.copy;
        g.fproto.execute = g.fsave.execute; g.fproto.changePath = g.fsave.changePath;
    }
    if (g.dsave && g.dproto) {
        g.dproto.create = g.dsave.create; g.dproto.remove = g.dsave.remove;
        g.dproto.rename = g.dsave.rename; g.dproto.execute = g.dsave.execute;
        g.dproto.changePath = g.dsave.changePath;
        // copy 槽同款 typeof 守卫（存在才打过补丁、存在才还原——不在原型上留 undefined 自有属性）
        if (typeof g.dsave.copy === "function") { g.dproto.copy = g.dsave.copy; }
    }
    if (g.hasCS && typeof system !== "undefined" && system) { system.callSystem = g.saveCS; }
    if (g.hasBT) { BridgeTalk = g.saveBT; }
    if (g.hasSK) {
        Socket = g.saveSK;
        if (typeof $ !== "undefined" && $.global) { $.global.Socket = g.saveSK; }
    }
    if (g.hasST && typeof app !== "undefined" && app) { app.scheduleTask = g.saveST; }
    // 清空保存引用（不留常驻引用——恢复后窗口外无原方法可捡拾）
    g.fproto = null; g.dproto = null; g.fsave = null; g.dsave = null;
    g.saveCS = null; g.saveBT = null; g.saveSK = null; g.saveST = null;
    g.hasCS = false; g.hasBT = false; g.hasSK = false; g.hasST = false;
    // 正常归零同步清持久化槽（补丁已对称还原，无需再恢复）
    _clearPersistedGuard();
}
// ============================================================================
// 授权代码文本黑名单（模块加载期构建；内核在执行前用它预检）
//   —— 为什么需要「内部名派生名单」（在 AE 内实测）
//   ExtendScript 的 new Function **不隔离作用域链**：body 能读写其编译点调用链上的
//   一切绑定——包括本模块 IIFE 的顶层名与 executeExtendScript 的局部名。实测（面板
//   CDP → evalScript，同引擎）：
//     (function(){var __q=7; (new Function("__q=5"))(); return __q;})()  → 5
//     (function(){var m="SECRET"; (function(){return (new Function(
//        "m='PWNED'"))();})(); return m;})()                            → PWNED
//   即：**名字仍是可达的**——只要它以字面标识符出现在 code 里。所以「内部名」必须与
//   __ael/__aeS* 同列进文本黑名单；作用域隐藏只能挡住「不写这个名字」的代码。
//   （动态构造标识符的通路已封：eval/Function 走 __prologue 局部声明遮蔽 +
//   `.constructor` 文本拦截；`this["_is"+"SensitivePath"]` 这类计算成员只作用于**全局
//   对象**，写不到模块/内核作用域的绑定，不构成绕过。）
//   口径 = 派生 + 测试兜底（两处，缺一不可）：
//     ① 用 acorn 派生「全部未导出顶层名 +
//        内核作用域名」，并用**源码里同一组成分重建**本正则后逐名断言命中——新增内部名
//        而漏登记会让防漂移测试变红，故名单完整性不需要人工维护；
//     ② 把真内核跑起来做**行为验收**：
//        用户实测 payload（_isSensitivePath = ...）必须被拒，普通代码不得误伤。
//   白名单（不进名单）：result 是授权代码的返回通道契约（必须可写）；args/code/ret 是
//   内核形参与局部，读取无害，且是通用词（授权代码常自用同名变量，禁掉会误伤）。
var _INTERNAL_NAMES = [
    // 未导出顶层名（守护判据 + 纯内部 + 内部常量）
    '_getItemIndex', '_getSourceKind', '_checkPath', '_shortNameKey', '_isSensitivePath',
    // Item 索引映射缓存与建表函数（授权代码按名可达，须进黑名单）
    '_buildItemIndexMap', '_itemIndexCache',
    // 参数式保存的产物核查 helper（对外入口是 saveProject，helper 不可按名可达）
    '_savedArtifactState', '_preflightSaveTarget',
    // importFile 的导入方式解析 helper（未导出顶层名，授权代码沿作用域链按名可达；
    // 对外入口只有 importFile 的 importAs 参数）
    '_importLayeredExt', '_applyImportMode',
    '_isSystemOrRootDir', '_rqStatusName', '_autoOrientName', '_getLayerType',
    '_findCompParents', '_findSourceRefs', '_getCompMarkers', '_getLayerMarkers',
    '_getLayerTypeCounts', '_buildLayerTreeForMatches', 'ADBE_MATCH', 'EXPR_MAX_LEN',
    // 渲染段助手（模板枚举匹配 / 产物核查 / 输出模块名）
    
    '_authFrame', '_guard',
    // 守卫原始引用持久化/自恢复（未导出顶层名，需登记进黑名单）
    '_GUARD_SLOT', '_persistGuard', '_clearPersistedGuard', '_recoverLeakedGuard',
    // 棘轮要求：内核作用域**新增名必须同时进运行时黑名单**——
    // 否则可经作用域链对授权代码可达（棘轮报错原文：「作用域链泄漏使其对授权代码可达；
    // 白名单仅 result/args/code/ret」）。__shadowAuth 是帧门面的遮蔽值，_gAuth 是门面的原值暂存。
    '__shadowAuth', '_gAuth',
    // 内核守卫工厂及其产物（同属未导出顶层名——不登记等于留一条按名替换守卫的入口）
    '_makeKernelGuards', '_kernelGuards',
    // 关键帧曲线：未导出顶层名——16 个 helper + 2 个枚举常量表
    // （登记后用户脚本按名引用会被拒；导出面只有 getKeyframeCurve/setKeyframeCurve）
    '_PV_FALLBACK', '_KI_FALLBACK', 
    
    
    // getPreviewFrame 多时间点：未导出顶层名——批抓函数与其批预算截止
    // （登记后用户脚本按名引用会被拒；入口只有 getPreviewFrame 的 timesInSeconds 分支）
    '_getPreviewFrames', '_previewFrameDeadlineAt',
    // 图层引用稳定键：未导出顶层名——id 解析 helper 与查询类合成定位 helper
    // （登记后用户脚本按名引用会被拒；对外只有既有查询函数的入参/回传扩展）
    '_readItemId', '_readLayerId', '_findItemById', '_findLayerById',
    // 宽松定位 _resolveQueryComp 已删除（layers/overview 改走严格路径）；
    // 新增 _describeArgValue（严格错误文案的值形态，字符串 "1" 与数字 1 可区分）——同为未导出
    // 顶层名，须进黑名单（不登记等于留一条按名替换文案判据的入口）。
    '_describeArgValue',
    // 读取分层：layers 内容摘要与 layer 深读 helper——均未导出顶层名，
    // 授权代码沿作用域链按名可达（可读工程内容/图层样式参数），必登记；
    // 对外入口只有 queryProject（content 摘要）与 queryDetails（layer 深读）。
    '_countTransformKeyframes', '_countEnabledLayerStyles', '_getLayerContentSummary',
    '_readMaskShape', '_readTextAnimators', '_readSourceTextKeyframes',
    '_readLayerStyleParams', '_readLayerStyles', '_isStyleParamGroup',
    // 图层动画指纹 helper——未导出顶层名，授权代码沿作用域链按名
    // 可达（可读动画属性名单/关键帧数/嵌套合成来源），必登记；对外入口仍是 queryProject
    //（layers/selected 条目的 anim 字段），总览入口 getOverviewInfo 已导出、不在此列。
    '_getLayerAnimSummary',
    // 参数形态校验：列表参数判数组 helper + fields 组选择解析 helper——
    // 均未导出顶层名，授权代码沿作用域链按名可达（改清单等于改可读字段面），必登记；
    // 对外入口仍是 queryProject/queryDetails 的入参。
    '_isArrayValue', '_parseFieldsArg',
    // 查询参数严格化：严格合成定位 helper（comp/layer/effect 共用）与
    // ids 数组校验 helper（layerIds/compositionIds/footageIds/overview compositionIds 四处共用）——
    // 均未导出顶层名，授权代码沿作用域链按名可达（改校验等于改可寻址对象面），必登记；
    // 对外入口仍是 queryProject/queryDetails 的入参。
    '_resolveStrictComp', '_resolveItemIds',
    // executeExtendScript 作用域内名（泄漏链可见）
    '_GateFile', '_GateFolder', '_sysPathOf', '_sysWriteGuard', '_hasBT', '_hasSocket',
    '_eval', '_Fn', '_GateRealFile', '_GateRealFolder', '_hasConfirm', '_hasPrompt',
    '_undoName', '_allow', '_allowSys', '_allowSock', '_allowFile', '_allowDialog',
    // 渲染触发避组：_renderTrigger 与 _userOwnsUndo 同在核作用域——
    // 登录黑名单，防授权代码沿作用域链读到它（读到即可判断「当前轮没套撤销组」）
    '_renderTrigger',
    // 渲染期对话框抑制：_suppressDialogs 同在核作用域——授权代码按名可达，
    // 赋值即可关掉抑制（等于「本轮不抑制」开关），必登记（棘轮派生覆盖）。
    '_suppressDialogs',
    // 失败回执 partial/recovery：_undoWrapped 是核 catch 的局部判据（本次调用
    // 是否真包了框架撤销组）——授权代码按名可达即可改写求值结果，必登记（棘轮派生覆盖）。
    '_undoWrapped',
    // 渲染前旧产物备份：_renderBackup 是核作用域内结果位；_backupRenderOutputs
    // 是导出到 $.global 的顶层函数（面板模板通道按名调用）；_realFileRename/_realFileRemove
    // 是模块加载时捕获的原型真方法（守卫窗口内绕开 throw 版补丁，见 helper 头注释）——授权代码
    // 按名可达，四者必登记。
    '_renderBackup', '_backupRenderOutputs', '_realFileRename', '_realFileRemove',
    '_realFileCtor',   // renderComp 用的真 File 构造器捕获（同属未导出顶层名）
    // 序列产物发现/改名/备份三件 + 真 Folder 构造器捕获——均做文件系统枚举或改名，
    // 授权代码按名可达，必登记。
    '_realFolderCtor', '_findRenderProducts', '_renameInGuardWindow', '_backupSequenceProducts',
    '_userOwnsUndo', '_ffs', '_fdecode', '_fencode', '_fisEnc', '_fopenDlg', '_fsaveDlg',
    '_dfs', '_ddecode', '_dencode', '_disEnc', '_dselectDlg', '_dtemp', '_ddesktop',
    '_dmydocs', '_dappdata', '_dcurrent', '_dstartup', '_duserdata', '_ptemp', '_pdesktop',
    '_pmydocs', '_pappdata', '_pcurrent', '_pstartup', '_puserdata', '_fproto', '_dproto',
    '_fpo', '_dpo', '__shadowFile', '__shadowFolder', '__shadowBT', '__shadowSock',
    '__shadowVals', '__prologue', '__userFn', '_guardSlotHost',
    // 名单自身的持有者：同属未导出顶层名——不登记等于留一条「关掉黑名单」的入口
    '_ESCAPE_PATTERNS', '_INTERNAL_NAMES', '_escapeRe'
];
var _ESCAPE_PATTERNS = '_cs\\b|__ael|__aeS|\\.evalFile|\\.global\\b|BridgeTalk'
    + '|\\bscheduleTask\\b|\\brunScriptFromFile\\b|_File\\b|_Folder\\b|_ef\\b|_bt\\b|_sk\\b'
    + '|_st\\b|_gFile\\b|_gFolder\\b|_gBT\\b|_alert\\b|_confirm\\b|_prompt\\b'
    + '|\\bcaller\\b|\\bcallee\\b|\\.execute\\s*\\(|\\.changePath\\s*\\(|\\.constructor\\b|__proto__';
var _escapeRe = new RegExp(_ESCAPE_PATTERNS + '|\\b(?:' + _INTERNAL_NAMES.join('|') + ')\\b', 'i');

// ============================================================================
// 内核侧守卫工厂化：守卫构造 + 判据值捕获
//   背景：AE 内 new Function 不隔离
//   作用域链——授权代码能按**字面标识符**读写调用链上的绑定。文本黑名单（_INTERNAL_NAMES）
//   是主防线，但内核守卫（_GateFile/_GateFolder/_sysWriteGuard/__aelPW/__aelPF/__aelPD）
//   若各自在**调用时按名**读模块级判据（_isSensitivePath / _isSystemOrRootDir）——
//   黑名单一旦出现缺口（漏登记 / 新判据忘登记），被改写的判据即可顶替真判据。
//   本工厂把守卫的**构造**移到模块级，判据值在**工厂自身 activation** 捕获：工厂于
//   模块加载期调用、返回后该 activation 即离开调用栈，不在授权代码的作用域链上
//   （与 __aeSGOn 同款、AE 内已实测印证的模式）——守卫此后只认捕获值。
//   per-call 值（授权位 file / 真构造器）经 setCtx 注入本闭包：保留既有「shadow 前
//   缓存」不变式（ES3 scope bug），守卫不按名读任何模块绑定。
//   残余（如实记录）：本工厂产物名 _kernelGuards 仍按名读取（文本黑名单 + closure-wrap
//   派生断言覆盖，与被取代的判据名同一保护等级）。
// ============================================================================
function _makeKernelGuards() {
    // 判据值捕获——本 activation 在工厂返回后即离开调用栈
    var sensFn = _isSensitivePath, sysFn = _isSystemOrRootDir;
    // per-call 注入位（内核每次调用先 setCtx）
    // 第 4 位 protoLayerLive：本窗口的原型层（真 File/Folder.prototype 补丁）
    //   是否可用——可用时 getFiles 条目**不再逐条包装**（理由见 __aelPD 内注释）。
    var allowFile = false, realFile = null, realFolder = null, protoLayerLive = false;
    function setCtx(af, rf, rfo, pll) {
        allowFile = (af === true); realFile = rf; realFolder = rfo; protoLayerLive = (pll === true);
    }
    // file 域：包装构造器（对齐落定 5/7）——敏感路径防线从「构造器 throw」
    // 升级为「构造期路径检查」（复用 _isSensitivePath 单点，即上方捕获值 sensFn；
    // 与 readFile/writeFile 参数式工具同款黑名单）。无 new 惯用法兼容（File("x")）。
    // 真构造器经 setCtx 传入（shadow 前缓存——ES3 scope bug 规避）。
    // 仅在 allowFile 时作为 File/Folder 的 shadow 形态安装；真实例的 .constructor 经
    // 真原型补丁同样指向此处（constructor 链堵漏——落定 8），重入路径检查在任何
    // allow 状态下保持。命名刻意不用 __ael 前缀（该族在静态黑名单内——包装构造器
    // 须可被用户代码正常引用）。
    function _GateFile(p) {
        if (!(this instanceof _GateFile)) return new _GateFile(p);
        if (sensFn(String(p))) {
            throw new Error("[AE_LLM] 敏感路径被拒（file 域）: " + String(p));
        }
        return new realFile(p);
    }
    function _GateFolder(p) {
        if (!(this instanceof _GateFolder)) return new _GateFolder(p);
        if (sensFn(String(p))) {
            throw new Error("[AE_LLM] 敏感路径被拒（file 域）: " + String(p));
        }
        return new realFolder(p);
    }
    // ── file 域**授权分支**写/删方向的「系统目录/盘根」守卫 ─────────
    // 修订前授权分支的唯一路径判据是凭据向 _isSensitivePath（系统目录零判据——实测
    // new File("C:/Windows/System32/config/SAM") 构造通过、open("w") 可写）。
    //   判据 = _isSystemOrRootDir（面板侧 client/shared/aefs.js 同名实现的镜像，
    //          与 writeFile 的 system_dir 同口径；parity 断言见
    //          Node 侧一致性用例）
    //   范围 = **只写/删方向**：open 仅写模式（w/a/e——与未授权分支同一判据）、
    //          remove / rename / copy / create；读方向（open("r") / readFile）一律不动
    //   落点 = 实例补丁（__aelPF / __aelPD）与原型补丁（_fproto / _dproto）**共用同一
    //          工厂**——两处各抄一份是漂移源（只改一处 → 另一条通道仍漏）
    function _sysPathOf(p) {
        var s = (p !== null && p !== undefined && typeof p === "object")
            ? (p.fsName || p.absoluteURI || p.path || "")
            : (p === null || p === undefined ? "" : p);
        return String(s);
    }
    // 目标位于系统目录/盘根 → 抛（文案与面板 writeFile 的 system_dir 语义对齐）
    function _sysWriteGuard(op, p) {
        var s = _sysPathOf(p);
        if (sysFn(s)) {
            throw new Error("[AE_LLM] " + op + " blocked — 目标位于系统目录/盘根（system_dir，与 writeFile 同口径；file 域授权不豁免）: " + s);
        }
    }
    // 写/删方向补丁工厂（obj 可为实例或原型）：只包 open 写模式 / remove / rename /
    // copy / create，守卫通过才委托原方法；execute / changePath 由既有无条件硬拒补丁负责
    //（不在此列——它们无能力域开关，与写/删分粒度正交）。
    function __aelPW(obj, isFolder) {
        if (typeof obj.open === "function") {
            var _wo = obj.open;
            obj.open = function (m) {
                if (m !== null && m !== undefined) {
                    var s = String(m).toLowerCase();
                    if (/^[a-z+]*$/.test(s) && /[wea]/.test(s)) _sysWriteGuard("File write", this);
                }
                return _wo.apply(this, arguments);
            };
        }
        if (typeof obj.remove === "function") {
            var _wr = obj.remove;
            obj.remove = function () {
                _sysWriteGuard(isFolder ? "Folder delete" : "File delete", this);
                return _wr.apply(this, arguments);
            };
        }
        if (typeof obj.rename === "function") {
            var _wn = obj.rename;
            obj.rename = function (t) {
                _sysWriteGuard(isFolder ? "Folder rename" : "File rename", this);
                _sysWriteGuard(isFolder ? "Folder rename" : "File rename", t);
                return _wn.apply(this, arguments);
            };
        }
        if (typeof obj.copy === "function") {
            var _wc = obj.copy;
            obj.copy = function (t) {
                _sysWriteGuard("File copy", this);
                _sysWriteGuard("File copy", t);
                return _wc.apply(this, arguments);
            };
        }
        if (typeof obj.create === "function") {
            var _wk = obj.create;
            obj.create = function () {
                _sysWriteGuard("Folder create", this);
                return _wk.apply(this, arguments);
            };
        }
    }
    // 真实例补丁函数（对齐 scriptRunner __aelPF/__aelPD）——shadow 后静态访问器
    // （Folder.temp 等）与 getFiles 返回条目不再直接暴露未包装真实例：真实例的
    // .execute()（启动任意可执行文件）/open("w")/remove 全部可用，
    // `var f=Folder.temp.getFiles()[0]; f.execute();` 是黑名单外的 RCE 通道。
    // File 构造器保持纯 throw（既有「File operations blocked」承诺），__aelPF 只用于
    // getFiles 返回的 File 条目；命名落在 __ael 黑名单段内：用户代码静态引用即被拒
    // （纵深防御）。条目分派用鸭子类型（getFiles/open 方法探测）：shadow 后 File/Folder
    // 已被全局替换，不依赖 _File/_Folder 做 instanceof（对齐 scriptRunner 同款写法）。
    // 分粒度：allowFile 时不再挂「throw 版」补丁（open 写模式/remove/rename/copy 是
    // file 能力部分——与原型补丁分粒度对称），改挂的系统目录/盘根守卫（见上），
    // execute/changePath 照旧无条件硬拒。
    function __aelPF(f) {
        if (!allowFile) {
            var _open = f.open;
            f.open = function (m) {
                if (m == null) return _open.apply(f, arguments);
                var s = String(m).toLowerCase();
                if (/^[a-z+]*$/.test(s) && /[wea]/.test(s)) throw new Error("[AE_LLM] File write disabled in executeExtendScript. Use readFile/writeFile tools instead.");
                return _open.apply(f, arguments);
            };
            f.remove = function () { throw new Error("[AE_LLM] File delete disabled in executeExtendScript. Use readFile/writeFile tools instead."); };
            f.rename = function () { throw new Error("[AE_LLM] File rename disabled in executeExtendScript."); };
            f.copy = function () { throw new Error("[AE_LLM] File copy disabled in executeExtendScript."); };
        } else {
            // 授权分支——写/删方向加系统目录/盘根守卫（读方向直通，见 __aelPW）
            __aelPW(f, false);
        }
        f.execute = function () { throw new Error("[AE_LLM] System call disabled in executeExtendScript."); };
        // changePath 拦截——真实例改指任意路径后 open("r")+read() 是敏感读取链
        f.changePath = function () { throw new Error("[AE_LLM] changePath disabled in executeExtendScript."); };
        return f;
    }
    function __aelPD(d) {
        if (!allowFile) {
            d.remove = function () { throw new Error("[AE_LLM] Folder delete disabled in executeExtendScript."); };
            d.create = function () { throw new Error("[AE_LLM] Folder create disabled in executeExtendScript."); };
            d.rename = function () { throw new Error("[AE_LLM] Folder rename disabled in executeExtendScript."); };
        } else {
            // 授权分支——Folder 侧写/删方向加系统目录/盘根守卫（同 __aelPF 的工厂）
            __aelPW(d, true);
        }
        d.execute = function () { throw new Error("[AE_LLM] System call disabled in executeExtendScript."); };
        d.changePath = function () { throw new Error("[AE_LLM] changePath disabled in executeExtendScript."); };
        // getFiles 返回的 File/Folder 条目：**仅在原型层不可用时**逐个补丁兜底
        //（ES3 无 Array.map，用循环）。口径：
        //   症状——逐条包装是 O(条目数) 的（每条 5-6 个闭包 + 改宿主对象属性），
        //   `Folder.temp.getFiles()` 在 74,251 条的 TEMP 上 ⇒ ≈40 万次闭包，AE 单核
        //   100% 卡死数分钟、面板全部 evalScript 超时（真机探针实锤）。
        //   判据——条目上的危险方法（execute / changePath / 写删方向）与本层同批已由
        // **原型层**（真 File/Folder.prototype 补丁，同一窗口安装、finally
        //   对称还原）覆盖，且覆盖方法集逐项一致（两处共用 __aelPW 工厂，allowFile
        //   两分支的文案也同源）⇒ 逐条包装是**冗余的第二层**。
        //   故：原型层可用（protoLayerLive）→ 条目直接透传，读放行/危险方法由原型层拦；
        //   原型层缺席的环境（无 prototype 的单测 mock、旧宿主）→ 保留逐条包装兜底。
        //   静态访问器克隆自身（__aelPD 的上半段）仍是 O(1) 的实例补丁，不变。
        //   无 getFiles 原型方法的环境（单测 mock）typeof 守卫跳过包装
        if (typeof d.getFiles === "function" && !protoLayerLive) {
            var _gf = d.getFiles;
            d.getFiles = function () {
                var r = _gf.apply(d, arguments);
                if (!r) return r;
                var out = [];
                for (var i = 0; i < r.length; i++) {
                    var e = r[i];
                    if (typeof e === "object" && e !== null && typeof e.getFiles === "function") out.push(__aelPD(e));
                    else if (typeof e === "object" && e !== null && typeof e.open === "function") out.push(__aelPF(e));
                    else out.push(e);
                }
                return out;
            };
        }
        return d;
    }
    return { setCtx: setCtx, gateFile: _GateFile, gateFolder: _GateFolder,
             pw: __aelPW, pf: __aelPF, pd: __aelPD };
}
var _kernelGuards = _makeKernelGuards();

function executeExtendScript(args) {
    // 作用域 shadow 沙箱 — replace regex blocklist (trivially bypassable via this['File']/$.global.File etc)
    // finally 早已在用（撤销组即 try/finally）；shadow 恢复不走 finally——
    // 所有原始引用在 try 前保存，catch 收口后直线段统一恢复（正常/异常路径均到达）
    // _eval/_Fn（eval/Function 无条件 shadow 原始引用）；_GateRealFile/
    // _GateRealFolder（包装构造器内真实构造器——shadow 前缓存，对齐 _gFile 先例）
    var code, _File, _Folder, _cs, _ef, _alert, _hasBT, _bt, _hasSocket, _sk, _st, _gFile, _gFolder, _gBT, result, ret,
        _eval, _Fn, _GateRealFile, _GateRealFolder, _gAuth,
        _confirm, _prompt, _hasConfirm, _hasPrompt;

    code = (args && args.code) ? String(args.code) : "";

    // —— 核内撤销组（机制在核/策略在调用方）——
    // 撤销组名从**授权帧**读（若经 args.__undoName 传入，authored 代码
    // 伪造该字段即可顶替组名——同一类逃逸面，随授权位一并换载体）。显示净化保持不变：
    // 控制字符/行终止符→空格 + 截断 30（undo 名进 Edit 菜单展示）。顺序同构：shadow（外）→
    // undo group（内）→ 用户代码——用户代码炸时 finally endUndoGroup 仍执行
    //（部分修改可整体撤回），shadow 恢复在最外层（catch 后统一段）。
    var _undoName = _authFrame.get().undoName || "";
    if (_undoName) {
        _undoName = _undoName.slice(0, 30).replace(/[\x00-\x1F\x7F\u2028\u2029]/g, " ");
    }

    // —— allow-set 执行参数（设计 4.1 终版矩阵「弹窗确认=当次授权」）——
    // 授权位从**授权帧**读：帧由面板在 authored 代码执行前用随机
    // 令牌建立（bootstrap 拼装模板），authored 代码既不持有令牌、也读不到拼装文本，
    // 故无法自授权；args.__allow 已彻底移除（无消费者）。能力域受控放行（4.2.1）：
    // system（callSystem）/socket 两域任一授权生效即放行该次——开关（持久授权，
    // agent-tool 通道）或 user-library 审计确认（当次授权）；scheduleTask/$.evalFile/
    // BridgeTalk 是硬拒项，无 allow 通道（设计铁律——持久化后门/文件加载/跨应用通信）。
    // allowAEToolsSystemCall 对本核生效（system/socket 授权即放行；不再是
    // 无条件拒 callSystem——开关只作用于 dispatcher sandboxBlock 的参数式工具）。
    var _allow = _authFrame.get().allow;
    var _allowSys = !!(_allow && _allow.system === true);
    var _allowSock = !!(_allow && _allow.socket === true);
    // file 域（对齐落定 5/7）：file 能力生效形态 = 包装构造器（敏感路径
    // _isSensitivePath 构造期检查）+ 原型/实例补丁分粒度（open 写模式/remove/
    // rename/copy 放行，execute/changePath 照拦）；_allowFile=false 时维持现行
    // throw 构造器形态（fail-closed 默认）
    var _allowFile = !!(_allow && _allow.file === true);
    // 弹窗域（「弹窗 = 通道固有属性」——不走能力域配置）：
    // true = 用户手动运行通道（脚本区/脚本树，服务层恒注入）→ 跳过 alert 重定向
    // 且不 shadow confirm/prompt（真弹窗，用户在场）；false（默认，Agent 自动执行
    // 通道不传）→ alert→$.writeln 重定向 + confirm/prompt shadow throw（纵深
    // 第二层——门侧 DIALOG_IDS 已按 source 静态拒，此处兜 bypass/旁路）
    var _allowDialog = !!(_allow && _allow.dialog === true);

    // —— 黑名单预检：拦截已知沙箱逃逸标识符 ——
    // ExtendScript 字符串沙箱无法真隔离（原始引用 _cs/__aelS 等与 eval(code) 同作用域，对抗性脚本可还原）。
    // 工具描述已声明"严禁 File/Folder/system.callSystem"，此处对 code 做静态检查，
    // 拦截 _cs/__ael/$.evalFile/$.global/callSystem/BridgeTalk 等逃逸载体，阻断 prompt 注入的 RCE payload。
    // __aeS*（__aeSG 导出面：__aeSGOn/__aeSGDn/__aeSAuth 门面——防护安装与判据
    // 全在 aeTools.jsx 闭包内，全局只剩这三个入口名，不再有持有真实 callSystem 的引用
    // 残留）：按名引用即拦截（文本层拦字面量，纵深第二层是闭包不可达）。
    // 正常 AE 对象模型代码（app/comp/layer/effect）不碰这些标识符，不受影响。
    // undoGroup（beginUndoGroup/endUndoGroup）：不再静态拒绝——用户导入的脚本
    // （脚本树/quickBar/热盒）常自带撤销组，一刀切拒绝会使其无法运行。检测到即
    // 跳过框架外层包裹（见下方 _userOwnsUndo），避免「框架外层组 + 用户内层组」
    // 嵌套触发 AE「Undo group mismatch」。agent-tool/llm-preview/ae-tool 通道仍由
    // AST 门拒（类型表不收录 begin/end——框架包裹照常，LLM 代码不得自行调用）。
    // Socket：完整 TCP 通道——AE 工程数据外发任意外部主机/探测内网/手写 HTTP 连本机
    // bridge 伪造 Origin 头绕过鉴权。bootstrap.js 的 SYSCALL_PATTERN 只测静态模板不测 args.code，
    // 此处是 LLM 动态代码的唯一守门人，必须自含 \bSocket\b 检查（对齐 validator.js/service.js）。
    // scheduleTask——app.scheduleTask(code, delay) 回调在脚本返回、shadow 已恢复之后
    // 执行（无沙箱全局作用域 eval 任意代码），时间窗绕过「静态黑名单+运行时 shadow」双层防线；
    // _st 为其原始引用保存变量，与 _sk 同款补 _st\b 静态阻断。
    // 黑名单补 \.execute\s*\(（File/Folder.execute 启动任意可执行文件，与
    // 「File operations blocked」承诺一致全拒；app.executeCommand 等不受影响——.execute
    // 后必须紧跟 "("）与 \.getFiles\b\s*\(\s*\)\s*\[（getFiles() 立即索引形态；先存变量
    // 再索引的合法只读遍历不受影响）。Folder.temp 等静态访问器与 getFiles 返回条目在
    // 运行时均已包装为只读安全实例，静态形态是纵深防御第一层。
    // 黑名单补 \.changePath\s*\(——AE 对象模型返回的真实 File 实例
    // （app.project.file、item.mainSource.file）不经被 shadow 的构造器，
    // changePath 改指任意路径 + open("r")（按设计放行）+ read() 构成敏感读取链，
    // _isSensitivePath 只挂 readFile/listFolderFiles 等工具入口、对代码通道不生效，
    // 静态黑名单是唯一防线。
    // callSystem/Socket 黑名单条目受 allow-set 条件化（4.2.1 受控
    // 放行——字面 regex 保持不动，两个能力域追加独立条件判定）；
    // scheduleTask/$.evalFile/BridgeTalk/runScriptFromFile 维持无条件拒（硬拒无通道）。
    // \.getFiles\b\s*\(\s*\)\s*\[（立即索引形态）移出字面 regex、追加
    // file 域条件（_allowFile 时放行——包装构造器 + 原型/实例补丁分粒度接管该面）；
    // \.execute\s*\(/\.changePath\s*\(/ 维持无条件（硬拒照拦——对齐落定 1）。
    // 补 \bcaller\b|\bcallee\b——arguments.callee.caller
    // 是**读拼装文本**的路径（caller.toString() 拿到面板拼装的整条脚本，其中含本帧
    // 令牌）。帧的安全性依赖「authored 代码读不到拼装文本」，门侧 META_PROPERTIES 只
    // 覆盖**过门通道**（agent-tool/LLM 作者面；外接也在内——
    // extBridgeClient 对 executeExtendScript 的 args.code 过同一道门），**hotbox 等
    // 不过门通道只能靠这条黑名单**（令牌一旦被读出即可自建同令牌帧顶替授权）。正常 AE
    // 对象模型代码（app/comp/layer/effect）不出现 caller/callee。
    // 补 \.constructor\b|__proto__——Function/eval 已由 __prologue
    // 局部声明遮蔽（内核通道）与工具码 IIFE 形参遮蔽（dispatcher 通道），
    // `({}).constructor.constructor` 是遮蔽名之后同一族仅剩的取真构造器路径；
    // 本条目是内核与 dispatcher 两个通道的**唯一共同文本点**（门产物另有
    // META_PROPERTIES 覆盖 constructor/__proto__ 成员名；**hotbox 不过门**，只能靠这条
    // ——外接同过门）。`\.constructor\b` 必须带前置点与后继词边界：无边界 `constructor`
    // 会误伤字符串/注释里的普通词（变异验证样本 `var label = "constructor";`）。
    if (_escapeRe.test(code)
        || (!_allowSys && /callSystem/.test(code))
        || (!_allowSock && /\bSocket\b/i.test(code))
        || (!_allowFile && /\.getFiles\b\s*\(\s*\)\s*\[/.test(code))) {
        return { status: "error", message: "[AE_LLM] executeExtendScript 拒绝：代码含沙箱逃逸/系统调用/网络通信/延迟执行/实例危险操作标识符（_cs/__ael/__aeS*/$.evalFile/$.global/callSystem/BridgeTalk/Socket/scheduleTask/runScriptFromFile/_File/_Folder/_ef/_bt/_sk/_st/_gFile/_gFolder/_gBT/_alert/_confirm/_prompt/caller/callee/.execute(/.changePath(/.constructor/__proto__/引擎内部名（_isSensitivePath/_isSystemOrRootDir/_GateFile/_fpo/_authFrame 等，完整名单见引擎侧 _INTERNAL_NAMES）/.getFiles()[）。Socket 是完整 TCP 通道（数据外泄/伪造 bridge 请求），默认无条件禁项（经 allow-set 受控放行——user-library 审计确认或能力域授权）。app.scheduleTask 回调在 shadow 恢复后执行（延迟绕过双层沙箱），禁止调用（硬拒无通道）。runScriptFromFile 在 host.jsx 顶层作用域 eval 文件内容，shadow 沙箱对其无效——禁止调用。File/Folder 实例的 execute()（启动任意可执行文件）一律拒绝；changePath()（真实例改指任意路径，敏感读取链一环）一律拒绝；Folder.getFiles()[ 立即索引形态默认拒绝（file 域授权后放行——静态访问器与 getFiles 返回条目按域分粒度包装）。如需 system.callSystem 等 capability 能力，请在「Agent 模块设置 > AST 门能力配置」开启对应能力域（或通道信任）。" };
    }

    // —— 用户脚本自带撤销组 → 跳过框架外层包裹（用户导入脚本兼容）——
    // AE 对嵌套撤销组不可靠：框架外层组与脚本内层组并存会触发「Undo group
    // mismatch」。故检测到脚本自身调用 begin/endUndoGroup 时不再叠加外层组，
    // 撤销语义（含不平衡的 begin/end）由脚本自负。检测面覆盖点号调用 / 计算键 /
    // 变量转发等字面量形态（含注释/字符串——宁可少包一次框架组，也不冒嵌套
    // mismatch 风险）。
    var _userOwnsUndo = /beginUndoGroup|endUndoGroup/i.test(code);

    // —— 渲染触发 → 同样跳过外层撤销组（真机复现定因）——
    // 渲染在撤销组内执行会让 AE 报「撤消组不匹配，将尝试修复。」并弹模态框，模态框
    // 期间脚本引擎不响应（面板全部依赖 ExtendScript 的能力一起挂）。**与渲染时长无关**：
    // 640×360 / 2 秒的小渲染即复现（当日实测渲染本体 8s 完成、调用仍卡到面板超时）。
    // 渲染没有可撤销语义（撤了也不会把已出产物变没），故与「脚本自带撤销组」同款处置。
    // 放宽：原判据只认 addToRenderQueue/startRender/renderQueue.render 字面形态——
    // `var q = app.project.renderQueue; q.render()` 与 `app["project"]["renderQueue"].render()`
    // 等别名/计算键写法全部漏判，渲染仍被包进撤销组（可达模态卡死，真机记录过）。
    // 新判据 = 便捷入口 | 任何 renderQueue 取用（覆盖别名/字符串键）| 任何 render( 调用。
    // 误伤代价仅是「少包一次外层撤销组」（可撤销语义损失，不影响执行正确性），
    // 与漏判代价（AE 模态卡死整条 ExtendScript 通道）不对称，取宽。
    // 判据与面板侧 bootstrap.js 同款（两处镜像，勿单改一处）：renderQueue 取用与底层
    // render() 调用写法；两个字面量 addToRenderQueue / startRender 已随
    // B 簇删除便捷入口，此处保留以兜住存量工具/用户脚本的既有写法（宽判据宁可误伤）。
    // 加 \brenderComp\b——参数式渲染工具（工具模板 `result = renderComp(__args);`
    // 与 authored 代码直调同款）也是渲染触发，须同样套对话框抑制/在途门/渲染前备份。
    var _renderTrigger = /\baddToRenderQueue\b|\bstartRender\b|\brenderQueue\b|\brender\s*\(|\brenderComp\b/i.test(code);

    // 渲染触发 → 覆盖前把已存在产物改名留一代（.prev）。
    // **必须在下方「保存原始引用 / shadow / 原型补丁」之前**：窗口内
    // `File.prototype.rename/remove` 是守卫的 throw 版（未授权 file 域时），备份会静默
    // 失效；此处 File/Folder 还是真构造器。判据与对话框抑制共用 _renderTrigger。
    // 失败只记 null（备份尽力而为，不影响渲染本体）；结果供回执如实上报。
    var _renderBackup = null;
    if (_renderTrigger) { try { _renderBackup = _backupRenderOutputs(); } catch (_rbe) { _renderBackup = null; } }

    // —— 保存原始引用 ——
    _File = File;
    _Folder = Folder;
    // 包装构造器内真实构造器（shadow 前缓存——对齐 _gFile 持有构造器引用的
    // 先例；不缓存则 shadow 后 _GateFile 内 new _File(p) 触发 ES3 scope bug）
    _GateRealFile = _File;
    _GateRealFolder = _Folder;
    // 落定 7：eval/Function 无条件 shadow 的原始引用（壳构造先于 shadow——
    // 核自身 new _Fn(code) 不受影响）
    _eval = eval;
    _Fn = Function;
    _cs = system.callSystem;
    // app.scheduleTask 原始引用——延迟执行通道（脚本返回后 shadow 已恢复，
    // scheduleTask 回调在无沙箱全局作用域 eval），静态黑名单外补运行时 shadow
    _st = app.scheduleTask;
    _ef = $.evalFile;
    _alert = alert;
    // 弹窗族原始引用（对齐 _alert 先例——typeof 守卫兼容单测 mock 环境未定义态）
    _hasConfirm = (typeof confirm !== "undefined");
    if (_hasConfirm) { _confirm = confirm; }
    _hasPrompt = (typeof prompt !== "undefined");
    if (_hasPrompt) { _prompt = prompt; }
    _hasBT = (typeof BridgeTalk !== "undefined");
    if (_hasBT) { _bt = BridgeTalk; }
    // Socket 运行时 shadow（黑名单外的第二层防线）——静态黑名单可被
    // ES3 标识符 \u 转义（S\u006Fcket）或字符串拼接（this["Sock"+"et"]）绕过，其余
    // 危险 API 均为「黑名单+shadow」双层防，Socket 单靠静态黑名单只有一层。$.global 即全局
    // 对象（ExtendScript $ 是全局对象本身），全局 Socket 赋值同时覆盖 $.global.Socket。
    // _hasSocket/_sk 必须在上方 var 清单声明（对齐 _hasBT/_bt）——不声明时是隐式全局，
    // new Function 作用域链含全局，用户代码 new _sk(...) 可拿到真实 Socket 引用完整绕过
    // 双层防线；黑名单同步补 _sk\b 阻断对该标识符的静态引用。
    _hasSocket = (typeof Socket !== "undefined");
    if (_hasSocket) { _sk = Socket; }
    if ($.global) {
        _gFile = $.global.File;
        _gFolder = $.global.Folder;
    }
    if (_hasBT && $.global) { _gBT = $.global.BridgeTalk; }

    // ── 内核侧守卫工厂化 ──────────────────────────────────────
    // 守卫（包装构造器 / 系统目录写删守卫 / 实例补丁 __aelPF/__aelPD）的构造与判据
    // 捕获已移至模块级工厂 _makeKernelGuards（完整背景见其头注释）：判据在工厂自身
    // activation 捕获，守卫不再在调用时按名读模块绑定——文本黑名单出现缺口也不再能
    // 顶替它们咨询的判据。此处仅注入 per-call 值（授权位 + shadow 前缓存的真构造器，
    // 保留既有 ES3 scope bug 规避不变式），再把守卫绑回原局部名（调用点零改动）。
    // 第 4 参 protoLayerLive：本窗口原型层是否可用（真构造器与其 prototype 同时在位
    // ⇒ 下方 _fproto/_dproto 补丁段必然安装）。两构造器任一缺 prototype 的环境视为
    // 不可用 → __aelPD 保留 getFiles 条目逐条包装兜底（见其内注释）。
    _kernelGuards.setCtx(_allowFile, _GateRealFile, _GateRealFolder,
        !!(_File && _File.prototype && _Folder && _Folder.prototype));
    var _GateFile = _kernelGuards.gateFile, _GateFolder = _kernelGuards.gateFolder,
        __aelPW = _kernelGuards.pw, __aelPD = _kernelGuards.pd;

    // Undo Group 由执行核统一包裹（authored 代码通道——_undoName
    // 经数据通道传入核内模板；参数式工具的模板包裹在 bootstrap dispatcher，
    // 固定模板+转义参数=CI 铁律合法例外）。
    try {
        // ExtendScript ES3 scope bug：一旦 var File = ... shadow，_File.xxx 读取也会 TypeError。
        // 必须在 shadow 前先把所有需要的静态属性缓存到普通变量。
        var _ffs = _File.fs, _fdecode = _File.decode, _fencode = _File.encode;
        var _fisEnc = _File.isEncodingAvailable, _fopenDlg = _File.openDialog, _fsaveDlg = _File.saveDialog;
        var _dfs = _Folder.fs, _ddecode = _Folder.decode, _dencode = _Folder.encode;
        var _disEnc = _Folder.isEncodingAvailable, _dselectDlg = _Folder.selectDialog;
        var _dtemp = _Folder.temp, _ddesktop = _Folder.desktop, _dmydocs = _Folder.myDocuments;
        var _dappdata = _Folder.appData, _dcurrent = _Folder.current, _dstartup = _Folder.startup, _duserdata = _Folder.userData;
        // 静态访问器改返回「打补丁的克隆实例」——直接透传 _dtemp 等缓存真实例时
        // 其 getFiles() 返回未包装真实 File（.execute()/open("w") 全可用）。先经 new _Folder(path)
        // 克隆再补丁：①克隆在 shadow 赋值前调用（规避上方 ES3 scope bug 对 shadow 后
        // _File/_Folder 操作的隐患）；②不污染引擎可能共享的真实静态实例（恢复段只还原
        // 构造器，救不回被原地补丁的实例）；③只读属性（fsName 等）经同路径克隆保真
        var _ptemp = __aelPD(new _Folder(_dtemp.fsName || _dtemp.absoluteURI));
        var _pdesktop = __aelPD(new _Folder(_ddesktop.fsName || _ddesktop.absoluteURI));
        var _pmydocs = __aelPD(new _Folder(_dmydocs.fsName || _dmydocs.absoluteURI));
        var _pappdata = __aelPD(new _Folder(_dappdata.fsName || _dappdata.absoluteURI));
        var _pcurrent = __aelPD(new _Folder(_dcurrent.fsName || _dcurrent.absoluteURI));
        var _pstartup = __aelPD(new _Folder(_dstartup.fsName || _dstartup.absoluteURI));
        var _puserdata = __aelPD(new _Folder(_duserdata.fsName || _duserdata.absoluteURI));

        // 原型层补丁（第二层防线）——实例补丁只覆盖静态访问器克隆/getFiles
        // 条目/构造器产物，但 File/Folder 的「返回新实例」通道会泄漏未补丁真实例：
        // .parent 访问器（Folder.temp.parent 返回引擎新建真实 Folder）、对话框静态方法
        // （openDialog/saveDialog/selectDialog 返回用户选定的新实例）——真实例的
        // .execute()/open("w")/remove 全部原生可用，是黑名单与实例补丁外的逃逸通道。
        // 沙箱窗口内同步执行（ExtendScript 单线程，无并发观察者），对原始构造器的
        // prototype 方法做补丁 + 恢复段对称还原：引擎经任何通道新建的实例，危险方法
        // 全部委托到被补丁的原型而被拦。mock 环境无 prototype 时守卫跳过（保留实例
        // 补丁层）。恢复段只还原构造器救不回原型方法——必须显式对称还原。
        // 分粒度（落定 5/7）：_allowFile 时不挂「throw 版」补丁，改挂写/删方向的
        // 系统目录/盘根守卫（open 写模式/remove/rename/copy——与 __aelPF/__aelPD 同工厂，
        // 避免两处各抄一份漂移）；execute/changePath 照旧无条件硬拒。
        // 补丁对象仍全量捕获（恢复段对称还原不受粒度影响）。
        // constructor 堵漏（落定 8）：真构造器原型补丁 _File.prototype.constructor
        // = _GateFile——真实例（app.project.file 等）的 .constructor 查真 File 原型链
        // 指向包装器（补包装器自己的 prototype 是 no-op），constructor 链构造重入
        // _isSensitivePath 路径检查；无条件安装（纯纵深——防门自身 bug 的后果封死）。
        var _fproto = (_File && _File.prototype) ? _File.prototype : null;
        var _dproto = (_Folder && _Folder.prototype) ? _Folder.prototype : null;
        var _fpo = null, _dpo = null;
        if (_fproto) {
            _fpo = { open: _fproto.open, remove: _fproto.remove, rename: _fproto.rename,
                     copy: _fproto.copy, execute: _fproto.execute, changePath: _fproto.changePath,
                     ctor: _fproto.constructor };
            if (!_allowFile) {
                _fproto.open = function (m) {
                    if (m == null) return _fpo.open.apply(this, arguments);
                    var s = String(m).toLowerCase();
                    if (/^[a-z+]*$/.test(s) && /[wea]/.test(s)) throw new Error("[AE_LLM] File write disabled in executeExtendScript. Use readFile/writeFile tools instead.");
                    return _fpo.open.apply(this, arguments);
                };
                _fproto.remove = function () { throw new Error("[AE_LLM] File delete disabled in executeExtendScript. Use readFile/writeFile tools instead."); };
                _fproto.rename = function () { throw new Error("[AE_LLM] File rename disabled in executeExtendScript."); };
                _fproto.copy = function () { throw new Error("[AE_LLM] File copy disabled in executeExtendScript."); };
            } else {
                // 授权分支——真原型层的写/删方向同样加系统目录/盘根守卫（引擎经任何
                // 通道新建的真实例都走这里；与实例补丁共用 __aelPW，避免漂移）
                __aelPW(_fproto, false);
            }
            _fproto.execute = function () { throw new Error("[AE_LLM] System call disabled in executeExtendScript."); };
            // changePath 拦截（与 __aelPF/静态黑名单三防线同步）
            _fproto.changePath = function () { throw new Error("[AE_LLM] changePath disabled in executeExtendScript."); };
            // 落定 8：真原型 constructor → 包装器（任何 allow 状态——路径检查重入）
            _fproto.constructor = _GateFile;
        }
        if (_dproto) {
            _dpo = { remove: _dproto.remove, create: _dproto.create,
                     rename: _dproto.rename, execute: _dproto.execute, changePath: _dproto.changePath,
                     ctor: _dproto.constructor };
            if (!_allowFile) {
                _dproto.remove = function () { throw new Error("[AE_LLM] Folder delete disabled in executeExtendScript."); };
                _dproto.create = function () { throw new Error("[AE_LLM] Folder create disabled in executeExtendScript."); };
                _dproto.rename = function () { throw new Error("[AE_LLM] Folder rename disabled in executeExtendScript."); };
            } else {
                // 授权分支——Folder 真原型层写/删方向补系统目录/盘根守卫
                __aelPW(_dproto, true);
            }
            _dproto.execute = function () { throw new Error("[AE_LLM] System call disabled in executeExtendScript."); };
            _dproto.changePath = function () { throw new Error("[AE_LLM] changePath disabled in executeExtendScript."); };
            _dproto.constructor = _GateFolder;
        }

        // —— Shadow File / Folder 构造函数（条件化：_allowFile → 包装构造器；否则 throw）——
        // 【实测修正：宿主全局必须用「用户函数体内的局部声明」遮蔽】——
        // File / Folder / alert / confirm 这些 **ExtendScript 宿主全局是只读绑定**：
        // 裸赋值 `File = X`（以及 `$.global.File = X`，同一个属性写）**静默失败**。
        // 实测证据（file 域关闭时）：
        //   String(File) → "function File() { [native code] }"（不是我们的 thrower）
        //   用户代码里 `File = thrower; new File("C:/")` → 仍能构造
        // 而 ECMAScript 内建是**可写**的：同样条件下 `eval` 的 shadow 生效（实测被拦）。
        // 即运行时 shadow 层对宿主全局整体空转——file 域关闭时构造/读文件/
        // 列目录全通，只剩原型层补丁挡住了写/删/执行。
        // 故宿主全局改走**局部声明**：函数作用域内的 var 必然遮蔽全局，与赋值能否
        // 生效无关。值为经参数传入的 shadow 对象——不在用户作用域里引用 _File/_Folder，
        // 避免触发上方注释里那个 ES3 作用域 bug。
        // 通道口径：下面两句与上方
        // File/Folder 拦截文案里的「use readFile/writeFile tools instead」是**面向面板通道**的
        // ——readFile/writeFile 是面板平台工具（`client/shared/platformTools.js` 注册为 global
        // scope、source=platform），**不进外接 MCP 白名单**（`extPolicy` 的 ae_data.fixed）。
        // 对**外接通道**，这句的落点是「改用你自己客户端自带的文件工具」——
        // 外接客户端（ZCode 等）本来就带文件读写，MCP 侧不为此放宽外接面，故此处文案不改
        // （内核拿不到通道标识，改也改不出通道感知的措辞）。
        var __shadowFile = _allowFile ? _GateFile
            : function() { throw new Error("[AE_LLM] File operations blocked in executeExtendScript. Use readFile/writeFile tools instead."); };
        var __shadowFolder = _allowFile ? _GateFolder
            : function() { throw new Error("[AE_LLM] Folder operations blocked in executeExtendScript. Use readFile/writeFile tools instead."); };
        // 静态属性挂在 shadow 对象上（挂在被赋值的全局上对宿主全局等于没挂）
        __shadowFile.fs = _ffs; __shadowFile.decode = _fdecode; __shadowFile.encode = _fencode;
        __shadowFile.isEncodingAvailable = _fisEnc; __shadowFile.openDialog = _fopenDlg; __shadowFile.saveDialog = _fsaveDlg;
        __shadowFolder.fs = _dfs; __shadowFolder.decode = _ddecode; __shadowFolder.encode = _dencode;
        __shadowFolder.isEncodingAvailable = _disEnc; __shadowFolder.selectDialog = _dselectDlg;
        // 静态访问器赋打补丁克隆（而非缓存真实例），getFiles 返回条目
        // 均经 __aelPF/__aelPD 包装，实例危险方法全拦、只读透传
        __shadowFolder.temp = _ptemp; __shadowFolder.desktop = _pdesktop; __shadowFolder.myDocuments = _pmydocs;
        // userData 改用与同排一致的包装克隆 _puserdata——修正前直接赋
        // 未包装真实例 _duserdata（静态访问器里唯一漏网项）：getFiles() 返回条目不过
        // __aelPF/__aelPD 实例包装（只剩原型层补丁兜底，纵深少一层；且把引擎共享实例
        // 直接交给用户代码）。同排 temp/desktop/myDocuments/appData/current/startup 均
        // 已用 _p* 克隆，参照实现
        // host/api/scriptRunner.jsx 的 Folder.userData=__aelPD(__aelD(...))。
        __shadowFolder.appData = _pappdata; __shadowFolder.current = _pcurrent; __shadowFolder.startup = _pstartup; __shadowFolder.userData = _puserdata;

        // 遮蔽项按加入顺序进 __shadowVals，__prologue 用同一顺序取下标（一一对应）。
        // 裸赋值 / $.global 赋值对宿主全局无效，但**保留**：对象属性写入
        //（system.callSystem / app.scheduleTask / $.evalFile）是否生效尚未单独验证，
        // 删掉会丢一层未知纵深；宿主全局那部分由 __prologue 兜住。
        // Function/eval 同走「局部声明」这条唯一可靠的路——
        // 两者是提取原语（Function 构造器 / eval），遮蔽失败即等于沙箱整体失效。
        // 实测事实：`Function` 在 ExtendScript 是**宿主全局/只读绑定**——裸赋值静默
        // 失败（Function === ({}).constructor.constructor 恒为 true）；`eval` 是
        // ECMAScript 内建、可写（裸赋值生效，但只改全局槽位、按名仍可拾取）。故与
        // File/Folder/BridgeTalk/Socket 同款：值以**内联函数表达式**进 __shadowVals
        //（不经全局名传递——名字即可达面），由 __prologue 在用户函数体内声明为局部
        // var；用户作用域里没有真构造器/真 eval 可拾。下方裸赋值保留为纵深（见其注释）。
        var __shadowBT = null, __shadowSock = null;
        // 帧门面遮蔽——**根因修复**：
        // 排查结论：`begin` 在 `_depth===0` 时**不校验任何来源**（令牌只与自身比较、payload 由调用方给），
        // 而 `__aeSG` 就是 `$.global`（本文件末行 `})(… $.global …)`）⇒ 门面**只有一个绑定、无别名**，
        // 谁碰到它就能 `end(令牌)`+`begin(令牌,{allow:全开})` 把帧重新武装（安全轮 mock 内核实跑成功），
        // 甚至直接 `begin(任意新令牌,{allow:全开})` 另起一帧——所以「封存已用令牌」是无效修法（已实测放弃）。
        // 唯一有效机制是本文件既有的 **prologue 局部 var 遮蔽**（File/Folder/Function/eval 同款：
        // `$.global.X = shadow` 对宿主全局静默失败，真正的拦截是函数作用域内的局部声明）。
        // 时间窗安全：模板是 begin →（装 __aeSGOn）→ authored 代码 →（卸 __aeSGDn）→ end
        //（bootstrap.js:511/536-537/542），建帧与关帧都在被遮蔽的窗口**之外** ⇒ 正常脚本零影响。
        var __shadowAuth = {
            begin: function() { throw new Error("[AE_LLM] __aeSAuth 在授权代码中不可用（帧由面板模板建立与关闭）"); },
            end: function() { throw new Error("[AE_LLM] __aeSAuth 在授权代码中不可用（帧由面板模板建立与关闭）"); },
            get: function() { throw new Error("[AE_LLM] __aeSAuth 在授权代码中不可用（帧由面板模板建立与关闭）"); }
        };
        var __shadowVals = [__shadowFile, __shadowFolder,
            function() { throw new Error("[AE_LLM] Function constructor blocked in executeExtendScript."); },
            function() { throw new Error("[AE_LLM] eval blocked in executeExtendScript."); },
            __shadowAuth];
        var __prologue = 'var __S=__aeShadowArgs,File=__S[0],Folder=__S[1],Function=__S[2],eval=__S[3],'
            + '__aeSAuth=__S[4];';
        // 静态访问器赋打补丁克隆（而非缓存真实例），getFiles 返回条目
        // 均经 __aelPF/__aelPD 包装，实例危险方法全拦、只读透传

        // —— 阻断危险全局 ——
        // callSystem/Socket 受 allow-set 条件化（当次授权——开关或
        // user-library 确认生效时不 shadow，原语直通）；scheduleTask/$.evalFile/
        // BridgeTalk 无 allow 通道（硬拒）
        if (!_allowSys) {
            system.callSystem = function() { throw new Error("[AE_LLM] system.callSystem blocked"); };
        }
        // scheduleTask 运行时防线——静态黑名单可被字符串拼接（"schedule"+"Task"）绕过，
        // shadow 期间一并替换为 throw（延迟回调即使登记也在本函数返回前被恢复，恢复前调用即抛错）
        app.scheduleTask = function() { throw new Error("[AE_LLM] app.scheduleTask blocked"); };
        $.evalFile = function() { throw new Error("[AE_LLM] $.evalFile blocked"); };
        if (_hasBT) {
            BridgeTalk = function() { throw new Error("[AE_LLM] BridgeTalk blocked"); };
            // BridgeTalk 亦是宿主全局：裸赋值无效 → 一并进 __prologue（具名持有，
            // 供下方 $.global 段引用，避免用"最后一个下标"这种会串位的写法）
            __shadowBT = function() { throw new Error("[AE_LLM] BridgeTalk blocked"); };
            __shadowVals.push(__shadowBT);
            __prologue += 'var BridgeTalk=__S[' + (__shadowVals.length - 1) + '];';
        }
        // Socket 运行时 shadow——拦截静态黑名单的 \u 转义/拼接绕过
        //（allow-set 放行时跳过；Socket 同属宿主全局 → 进 __prologue）
        if (_hasSocket && !_allowSock) {
            Socket = function() { throw new Error("[AE_LLM] Socket blocked"); };
            __shadowSock = function() { throw new Error("[AE_LLM] Socket blocked"); };
            __shadowVals.push(__shadowSock);
            __prologue += 'var Socket=__S[' + (__shadowVals.length - 1) + '];';
        }

        // —— 弹窗族 shadow（「弹窗 = 通道固有属性」）——
        // !_allowDialog（Agent 自动执行通道，默认）：alert→$.writeln 防阻断（原行为）
        // + confirm/prompt→throw（真实模态会挂起 AE 线程——纵深第二层，门侧
        // DIALOG_IDS 已按 source 静态拒，此处兜 bypass/旁路）。
        // _allowDialog（用户手动运行通道，服务层恒注入）：全部保持真实弹窗。
        if (!_allowDialog) {
            alert = function(msg) {
                $.writeln("[AE_LLM executeExtendScript alert] " + String(msg));
                return true;
            };
            confirm = function() {
                throw new Error("[AE_LLM] confirm() 阻断弹窗在 Agent 通道禁用（无人在场会挂起 AE）。请用 result 返回值传递信息。");
            };
            prompt = function() {
                throw new Error("[AE_LLM] prompt() 阻断弹窗在 Agent 通道禁用（无人在场会挂起 AE）。请用 result 返回值传递信息。");
            };
        }

        // —— 覆盖 $.global 旁路（对宿主全局已确认**无效**，保留为纵深）——
        // `$.global.File = X` 与裸赋值 `File = X` 是同一个属性写，实测后者对
        // File/Folder 静默失败（见上），故这一段对宿主全局不起作用；真正生效的是
        // __prologue 的局部声明。保留理由：万一某些宿主/版本下 $.global 属性写
        // 可用，它仍是多一层；且它对 __shadowFile/__shadowFolder 无副作用。
        if ($.global) {
            $.global.File = __shadowFile;
            $.global.Folder = __shadowFolder;
            if (_hasBT && __shadowBT) { $.global.BridgeTalk = __shadowBT; }
            if (_hasSocket && !_allowSock && __shadowSock) { $.global.Socket = __shadowSock; }
            // 帧门面的**全局属性**遮蔽（行为钉暴露的缺口）：
            // prologue 局部 var 只遮蔽**标识符** `__aeSAuth`，而 `__aeSG` 就是 `$.global`
            //（本文件末行 `})((… && $.global) ? $.global : this)`）⇒ 计算成员
            // `this["__ae" + "SAuth"]` 仍能拿到真门面，重新武装帧的攻击照样成立。
            // 上面那段注释说 `$.global.File = …` 对**宿主内建**静默失败——但 `__aeSAuth` 是
            // **我们自己赋的普通可写属性**（见本文件末尾导出块的 `__aeSG.__aeSAuth` 赋值），
            // 故这次赋值**真的生效**。
            // 注意：本行注释**不得**写出「`__aeSG.__aeSAuth` 紧跟 = 与左花括号」的字面串——
            // 提取器 `extractAuthFacade` 用它做锚点，注释命中会把
            // 105KB 无关源码切进门面片段、套件当场语法错（本行即为修复该自伤）。
            // 还原见下方 restore 段（漏还原 ⇒ 之后所有调用建不了帧，模板 begin 会命中遮蔽值）。
            _gAuth = $.global.__aeSAuth;
            $.global.__aeSAuth = __shadowAuth;
        }

        // 用 new Function 包裹而非裸 eval：让用户代码中的 return 合法工作
        //（eval 解析为 Program，顶层 return 是 SyntaxError；FunctionBody 内 return 合法）。
        // shadow 沙箱仍有效：File/Folder 等是对全局的重新赋值（非 var 局部），
        // new Function 作用域链含全局，能看到 shadow 后的值。
        // 额外好处：var 声明不再泄漏到全局，避免变量残留污染后续调用。
        // 宿主全局的 shadow 经**参数**传入、由 __prologue 在用户函数体内声明为局部
        // var（裸赋值对宿主全局无效，见上方 Shadow File 段注释）。prologue 与 code
        // 之间**不插换行**：保持用户代码的行号与提交时一致（ES 报错行号不偏移）。
        var __userFn = new _Fn('__aeShadowArgs', __prologue + code);
        // eval/Function 无条件 shadow（纯纵深
        // ——无域无 bypass 豁免；壳构造先于 shadow，核自身 new _Fn(code) 不受影响）。
        // **实测事实**：下面这两行裸赋值只是纵深——`eval` 是 ECMAScript 内建、可写，
        // 裸赋值生效（改的是全局槽位）；`Function` 在 ExtendScript 是宿主全局/只读
        // 绑定，裸赋值**静默失败**（实测 Function === ({}).constructor.constructor
        // 恒 true，赋值后 String(Function) 仍是 "[native code]"）。实际拦截由上方
        // __prologue 的局部声明（var Function=__S[2],eval=__S[3]）承担——函数作用域
        // 内的 var 必然遮蔽全局，与赋值能否生效无关（File/Folder/BridgeTalk/Socket
        // 已走同一条路）。保留裸赋值：万一某些宿主/版本下 Function 可写，它仍是多
        // 一层（对齐下方 $.global 段的保留理由）。间接调用同拦：用户代码内
        // var e = eval / var F = Function 解析到 prologue 局部 shadow；constructor 链
        //（({}).constructor.constructor）取得的真 Function 造出的代码执行时全局
        // File/Socket/callSystem 已是 shadow 版——逃逸可能发生、逃逸后无能力可用
        //（后果封死），且 `.constructor` 字面量已进文本黑名单。
        eval = function() { throw new Error("[AE_LLM] eval blocked in executeExtendScript."); };
        Function = function() { throw new Error("[AE_LLM] Function constructor blocked in executeExtendScript."); };
        // 核内撤销组：shadow 已安装（外），undo 组在内、
        // 用户代码之前——beginUndoGroup 自身抛错（极端）时内层 try 未进入，
        // end 不执行不会失配；用户代码炸时 finally 仍 endUndoGroup（部分修改
        // 可整体撤回），异常继续外抛由外层 catch 收口、shadow 在 catch 后恢复。
        // 用户脚本自带撤销组（_userOwnsUndo）时跳过外层组——避免嵌套 mismatch，
        // 撤销语义由脚本自负。渲染触发（_renderTrigger）同样跳过——渲染在组内会让
        // AE 报「撤消组不匹配」并弹模态卡住脚本引擎（真机复现定因）。
        // —— 渲染触发 → 执行期抑制 AE 对话框（真机三阶段对照定因）——
        // 渲染输出模块指向**已存在文件**时 AE 弹应用级警告（AE 23.5 中文界面原文：
        // 「所选输出模块将覆盖已存在的文件。要允许此操作，请按"确定"。」），模态期间
        // 脚本引擎不响应——整条 ExtendScript 通道（面板全部依赖它的能力）一起挂到用户
        // 点掉为止；LLM 无人值守跑渲染即表现为「运行被弹窗阻塞」。实测（320×180 / 1 帧 /
        // H.264，AE 23.5）：
        //   ① 不抑制 + 产物已存在 → render() 卡住不返回（实测阻塞 1,794,803ms ≈ 29.9 分钟，
        //      直到人工点「确定」才继续；点击前产物未更新），点掉后照常覆盖（20B → 11237B，DONE）；
        //   ② beginSuppressDialogs + 产物已存在 → 无弹窗，8.5s 渲完且旧文件**被覆盖**
        //      （20B → 11237B，status DONE）——抑制后 AE 走「确定」语义，不是静默取消；
        //   ③ beginSuppressDialogs + 产物不存在 → 3.5s 正常出片（抑制不动渲染本体）。
        // 该警告是 AE **应用级**对话框，故抑制有效——与「Replace Footage
        // 的文件框躲不开」不同族（那是系统文件框），勿类比外推。
        // endSuppressDialogs(false)：不补弹被抑制的警告；成对在 finally（用户代码炸时
        // 仍闭合，否则抑制状态泄漏到之后全部调用）。判据与撤销组跳过共用 _renderTrigger
        // （非渲染脚本的对话框语义原样保留）。authored 代码自己写不了 beginSuppressDialogs
        // ——AST 门刻意不收录该成员（fail-closed，见 ast-gate/tables.js Application 段），
        // 故不存在与用户脚本抢抑制窗口的路径。
        var _suppressDialogs = _renderTrigger;
        if (_suppressDialogs) { try { app.beginSuppressDialogs(); } catch (_bs) { _suppressDialogs = false; } }
        // 撤销组是否**真的建成**（beginUndoGroup 自身抛错时组不存在，失败回执的
        // recovery 不得承诺可整体回滚，见下方 catch）。下一行 begin 抛错时本变量不会被置真。
        var _undoWrapped = false;
        if (_undoName && !_userOwnsUndo && !_renderTrigger) { app.beginUndoGroup("AS_ExtP: " + _undoName); }
        _undoWrapped = !!(_undoName && !_userOwnsUndo && !_renderTrigger);
        try {
            result = __userFn(__shadowVals);
        } finally {
            if (_undoName && !_userOwnsUndo && !_renderTrigger) { try { app.endUndoGroup(); } catch (_eu) {} }
            if (_suppressDialogs) { try { app.endSuppressDialogs(false); } catch (_es) {} }
        }
        // result 为 undefined（AE 操作代码多数不 return）时附带简短说明，避免 LLM 误判执行失败。
        // 对象/数组**原值透传**（result 保持对象），序列化交给拼装脚本末句与外层各自完成——
        // 核内先 JSON.stringify 一次、外层编码再套一层时，外部客户端拿到的是
        // {"status":"success","result":"{\"status\":\"success\",...}"} 这种双层 JSON 字符串
        // （外接反馈：需二次解析、两层 success 语义难分）。
        // 透传前仍先在核内试序列化一次：宿主对象（Layer/CompItem）可能带循环引用，直接透传
        // 会让拼装脚本末句的 JSON.stringify 抛错、把成功的操作报成 error——失败即回退
        // String(result)，与既有口径一致（结构保持意图不变）。
        if (result === undefined) {
            ret = { status: "success", result: "undefined", message: "代码执行成功，未返回任何值（AE 操作多数如此）。" };
        } else if (result !== null && typeof result === "object") {
            try {
                JSON.stringify(result);
                ret = { status: "success", result: result };
            } catch (e2) {
                ret = { status: "success", result: String(result) };
            }
        } else {
            ret = { status: "success", result: String(result) };
        }
    } catch (e) {
        // 失败回执加机器可读字段（不改 {status,message} 协议，旧调用方不受影响）：
        //   partial:'unknown' —— 脚本抛错前可能已部分执行，异常本身不携带「改到哪一步」信息；
        //   recovery          —— 回滚提示。仅当本次调用由框架**实际建起**撤销组（上方
        //                        _undoWrapped）时承诺可整体回滚；其余路径（脚本自带撤销组、
        //                        触发渲染、撤销组建组失败）按脚本自身的撤销语义处理。
        ret = {
            status: "error",
            message: e.toString(),
            partial: "unknown",
            recovery: _undoWrapped
                ? "本次调用已由框架包撤销组，可用 undoLastOperation 回滚本次调用产生的修改。"
                : "本次调用未包框架撤销组（脚本自带撤销组、触发了渲染，或撤销组建立失败），回滚按脚本自身的撤销语义处理。"
        };
        // 运行时错误行号上报：AE 对 new Function 函数体的报错行从 2 起（包装头占一行），
        // 减固定偏移后即 AST 门 reemit 产物行（1-based）；该行号不是用户原文行——
        // agent 工具管线用 gate.lineMap 映射回原文行（成功标 source，否则 emitted），
        // 服务侧脚本运行链路用 mapProductLine 映射。非对象 throw / 无 line 属性时缺省，
        // {status} 协议向后兼容。
        if (e && typeof e.line === "number" && e.line > 0) { ret.line = e.line > 1 ? (e.line - 1) : 1; }
    }

    // 渲染备份如实上报（成功/失败路径都挂）：产物被改名的数量——不报等于用户事后
    // 在产物目录里发现 .prev 文件却不知谁写的。backed=0 不挂字段（无噪音）。
    if (_renderBackup && _renderBackup.backed > 0) {
        ret.renderBackup = {
            backed: _renderBackup.backed,
            note: "覆盖前已把 " + _renderBackup.backed + " 个已存在的渲染产物改名留一代（<名>.prev<扩展名>）"
        };
    }

    // -- restore original refs (ES3 no finally) --
    File = _File;
    Folder = _Folder;
    // 还原原型方法（与补丁对称）——恢复段只还原构造器救不回被补丁的
    // prototype 方法，不还原则沙箱窗口结束后全引擎 File/Folder 实例的危险方法
    // 永久残废（读写工具 readFile/writeFile 等立即连锁失效）
    if (_fpo) {
        _fproto.open = _fpo.open; _fproto.remove = _fpo.remove; _fproto.rename = _fpo.rename;
        _fproto.copy = _fpo.copy; _fproto.execute = _fpo.execute; _fproto.changePath = _fpo.changePath;
        // 真原型 constructor 对称还原（堵漏补丁的恢复）
        _fproto.constructor = _fpo.ctor;
    }
    if (_dpo) {
        _dproto.remove = _dpo.remove; _dproto.create = _dpo.create;
        _dproto.rename = _dpo.rename; _dproto.execute = _dpo.execute; _dproto.changePath = _dpo.changePath;
        _dproto.constructor = _dpo.ctor;
    }
    // eval/Function 对称还原（与上方裸赋值镜像）。
    // `eval` 槽位确被改写过 → 本行真正还原；`Function` 槽位从未被改写（宿主全局
    // 只读，写入静默失败）→ `Function = _Fn` 是无害 no-op，保留以维持对称性与
    // 宿主差异兜底（函数体内的局部声明随每次 new _Fn 构造的函数体自动丢弃，无需还原）。
    eval = _eval;
    Function = _Fn;
    system.callSystem = _cs;
    // 还原 app.scheduleTask
    app.scheduleTask = _st;
    $.evalFile = _ef;
    alert = _alert;
    // 弹窗族对称还原（_hasConfirm=false 的 mock 环境赋 undefined——清掉 shadow
    // 残留；_allowDialog 未 shadow 时还原为原值，无操作差）
    if (_hasConfirm) { confirm = _confirm; } else { confirm = undefined; }
    if (_hasPrompt) { prompt = _prompt; } else { prompt = undefined; }
    if (_hasBT) { BridgeTalk = _bt; }
    // 还原 Socket（$.global 与全局同对象，双写与 File/Folder 同款防御）
    if (_hasSocket) {
        Socket = _sk;
        if ($.global) { $.global.Socket = _sk; }
    }
    if ($.global) {
        $.global.File = _gFile;
        $.global.Folder = _gFolder;
        if (_hasBT) { $.global.BridgeTalk = _gBT; }
        // 帧门面属性还原（与安装段对称）：漏还原 ⇒ 门面永久被换成遮蔽值
        // ⇒ **之后所有调用都建不了帧**（模板 `__aeSAuth.begin(...)` 会抛），AE 工具全线失效。
        if (_gAuth !== undefined) { $.global.__aeSAuth = _gAuth; }
    }

    return ret;
}

// 撤销 AE 撤销栈最近一次操作（等效 Ctrl+Z），供 undoLastOperation 内建工具调用。
// 主路径直接用 AE 内建的「撤销」命令 ID（16，多语言通用），避免 findMenuCommandId
// 按本地化菜单字符串查找的脆弱性（菜单标题会动态带上操作名，如「撤销 新建固态层」）。
function undoLastOperation(args) {
    var UNDO_CMD_ID = 16; // Edit > Undo（hyperbrew AE 2025 菜单扫描与 Torno CC 列表均确认为 16；2371 是 Purge > Undo，勿用）
    var undoNames = ["Undo", "撤销", "元に戻す", "Rückgängig", "Deshacer", "Annuler"];
    try {
        // ① 首选内建命令 ID
        try {
            app.executeCommand(UNDO_CMD_ID);
            return { status: "success", message: "Undo executed", commandId: UNDO_CMD_ID, matchedName: "BuiltinUndoCommandID" };
        } catch (_) {
            // ② 兜底：多语言菜单名依次尝试
        }
        for (var i = 0; i < undoNames.length; i++) {
            var cmdId = 0;
            try { cmdId = app.findMenuCommandId(undoNames[i]); } catch (_) { cmdId = 0; }
            if (cmdId && cmdId !== 0) {
                app.executeCommand(cmdId);
                return { status: "success", message: "Undo executed", commandId: cmdId, matchedName: undoNames[i] };
            }
        }
        return { status: "error", message: "Undo menu command not found in any known language (tried: " + undoNames.join(", ") + ")" };
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

// -- 路径格式校验（对齐 AEFS _checkPath 五道防线，ExtendScript 版） --
// 拒 %/控制字符/引号/../.段/非绝对路径/DOS 设备名。返回 true=合法，false=非法。
// ExtendScript 无 console，校验失败仅返回 false，由调用方 throw 带路径信息的错误。
function _checkPath(p) {
    if (!p || typeof p !== "string") return false;
    // ① 拒 %（URL 编码攻击，合法路径无需编码）
    if (p.indexOf("%") >= 0) return false;
    // ② 拒控制字符（0x00-0x1F / 0x7F）和引号 " '
    for (var i = 0; i < p.length; i++) {
        var c = p.charCodeAt(i);
        if (c <= 0x1F || c === 0x7F || c === 0x22 || c === 0x27) return false;
    }
    // ③ 拒 . 或 .. 作为完整路径段（含 : 边界，防 D:.. 形式）
    if (/(^|[\\\/\:])\.\.([\\\/\:]|$)/.test(p) || /(^|[\\\/\:])\.([\\\/\:]|$)/.test(p)) return false;
    // ④ 必须是绝对路径：盘符开头（D:/）或 file:///D:/ 格式
    var cleaned = p.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (/^[A-Za-z]:\//.test(cleaned)) {
        // 正常盘符路径
    } else if (/^file:\/+/i.test(cleaned)) {
        var stripped = cleaned.replace(/^file:\/+/i, "");
        if (!/^[A-Za-z][:\|]\//.test(stripped)) return false;
    } else {
        return false;
    }
    // ⑤ 拒 DOS 保留设备名（全路径段，去扩展名后判断，NUL.txt 也是设备）
    var segs = cleaned.replace(/\/+$/, "").split("/");
    for (var j = 0; j < segs.length; j++) {
        var upper = segs[j].replace(/\..*$/, "").toUpperCase();
        if (upper === "NUL" || upper === "CON" || upper === "CONIN$" || upper === "CONOUT$" ||
            upper === "PRN" || upper === "AUX" ||
            /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) return false;
    }
    return true;
}

// -- 敏感路径拒读：防提示注入驱动 readFile/listFolderFiles 读取本机密钥/凭据外发 --
// 归一化后按段匹配（目录段黑名单 / DPAPI 组合段 / 文件名黑名单 / 文件名模式）。
// Win32 8.3 短名键——系统卷默认开启短名生成（NtfsDisable8dot3NameCreation
// 默认按卷启用），黑名单长名文件的确定性短别名与精确全等/后缀匹配全部失配（实测：
// Login Data→LOGIND~1、Local State→LOCALS~1、Web Data→WEBDAT~1、logins.json→
// LOGINS~1.JSO、signons.sqlite→SIGNON~1.SQL、login.keychain-db→LOGIN~1.KEY、
// .env→ENV~1、.env.local→ENV~1.LOC、.envrc→ENVRC~1、.git-credentials→GIT-CR~1、
// .netrc→NETRC~1、id_ed25519→ID_ED2~1；.pem/.key 后缀不受影响——短名扩展恰好保留
// 3 字符，server.pem→SERVER~1.PEM 仍以 .pem 结尾）。生成规则（实测归纳）：name/ext
// 以「位置>0 的最后一个点」分界，两部分各去点与空格后取 name 前 6 / ext 前 3 字符，
// 前导点文件（.env）整体为 name。DPAPI 组合段 microsoft/credentials（9/11 字符）
// 的短名 MICROS~1/CREDEN~1 同理由该键比对覆盖。
function _shortNameKey(name) {
    var dot = name.lastIndexOf(".");
    var nm = dot > 0 ? name.substring(0, dot) : name;
    var ext = dot > 0 ? name.substring(dot + 1) : "";
    var n = nm.replace(/[ .]/g, "").substring(0, 6);
    if (!n) return "";
    // 仅「有短名形态」的条目参与比对：前导点文件（dot===0）/含空格/去点空格后超
    // 8 字符——≤8 字符的合法名（cookies/key4.db）无短名别名，生成键会把 cookie~1
    // 误判为 cookies 的短名（实测 cookies 短名就是自身）
    var plain = name.replace(/[ .]/g, "");
    if (dot !== 0 && name.indexOf(" ") < 0 && plain.length <= 8) return "";
    return n + "|" + (ext ? ext.replace(/[ .]/g, "").substring(0, 3) : "");
}
function _isSensitivePath(p) {
    if (!p) return false;
    // 归一化：反斜杠→/、转小写、压缩连续斜杠
    var norm = String(p).replace(/\\/g, "/").toLowerCase();
    norm = norm.replace(/\/+/g, "/");
    var segs = norm.split("/");
    var i, j;
    // 每段剥尾随点/空格再比对——Win32 路径规范化会静默剥掉段尾的点与
    // 空格（"C:/x/.aws." 实际打开 "C:/x/.aws"），精确全等匹配可被尾点绕过
    //（.ssh. / .kube. / microsoft./credentials. 同理）；剥后不影响 .env / .pem
    // 等无尾点形态的既有判定
    for (i = 0; i < segs.length; i++) {
        segs[i] = segs[i].replace(/[. ]+$/, "");
    }
    // 每段再剥 NTFS 备用数据流（ADS）后缀——Win32 下 "id_rsa：$DATA" 打开的
    // 就是 id_rsa 本体（::$DATA 为默认流语法），归一化后 base 为 "id_rsa::$data"，与黑名单
    // "id_rsa" 全等失配，".pem/.key 结尾" 的后缀匹配同样失配（"server.pem::$data" 不以
    // .pem 结尾）。剥段内首个冒号起至段尾再比对（"server.pem:stream" → "server.pem"），
    // 剥后补剥尾随点/空格（".ssh.:stream" 双重绕过复合形态）。盘符段（单字母+冒号，如
    // "c:"）不剥；对无冒号的合法路径零影响（防御性修复，不依赖 ExtendScript 透传实测）
    for (i = 0; i < segs.length; i++) {
        if (segs[i].length === 2 && segs[i].charAt(1) === ":") continue;  // 盘符段保护
        var adsAt = segs[i].indexOf(":");
        if (adsAt >= 0) segs[i] = segs[i].substring(0, adsAt).replace(/[. ]+$/, "");
    }
    // 段级 8.3 短名键（name~N[.ext] 形态提取，与 _shortNameKey 同构；
    // name/ext 字符类含连字符——短名部分可含 -（实测 GIT-CR~1））
    var segKeys = [];
    for (i = 0; i < segs.length; i++) {
        var mk = /^([a-z0-9_-]{1,6})~[0-9]{1,2}(?:\.([a-z0-9_-]{1,3}))?$/.exec(segs[i]);
        segKeys[i] = mk ? (mk[1] + "|" + (mk[2] || "")) : "";
    }
    // 1) 目录段黑名单：任一段精确命中即拒（短名键同比对）
    var dirBlacklist = [".ssh", ".aws", ".azure", ".gcloud", ".gnupg", ".kube", ".docker", ".config"];
    for (i = 0; i < segs.length; i++) {
        for (j = 0; j < dirBlacklist.length; j++) {
            if (segs[i] === dirBlacklist[j]) return true;
            if (segKeys[i] && _shortNameKey(dirBlacklist[j]) === segKeys[i]) return true;
        }
    }
    // 2) DPAPI 组合段：连续 microsoft/credentials 或 microsoft/protect（短名键同比对；
    // protect 为 7 字符合法名无短名形态，原样比对已足够）
    var msKey = _shortNameKey("microsoft");
    var crKey = _shortNameKey("credentials");
    for (i = 0; i < segs.length - 1; i++) {
        var msHere = segs[i] === "microsoft" || (segKeys[i] !== "" && segKeys[i] === msKey);
        var credNext = segs[i + 1] === "credentials" || (segKeys[i + 1] !== "" && segKeys[i + 1] === crKey);
        if (msHere && (credNext || segs[i + 1] === "protect")) return true;
    }
    // 3) 文件名黑名单 + 模式（basename = 最后一段）
    var base = segs.length > 0 ? segs[segs.length - 1] : "";
    var baseKey = segs.length > 0 ? segKeys[segs.length - 1] : "";
    if (base) {
        // 配置自保护延伸：门增补表/危险脚本记忆两存储文件——LLM 宽通道
        // （writeFile 参数工具 + 核内 file 域写 + 外层路径补丁）三面经本单点拒；
        // 写入仅经提议确认弹窗（userTable.js）与管理面（记忆模块）。全名精确匹配，
        // 不挡 .json 通配（防误伤用户普通 json）。
        var fileBlacklist = ["login data", "cookies", "local state", "web data", "key4.db",
            "logins.json", "signons.sqlite", "login.keychain-db", ".netrc", ".npmrc",
            ".pypirc", ".git-credentials", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", ".pgpass",
            "ast-gate-user-table.json", "script-danger-memory.json", "credentials", "cookies.db"];
        for (i = 0; i < fileBlacklist.length; i++) {
            if (base === fileBlacklist[i]) return true;
            if (baseKey && _shortNameKey(fileBlacklist[i]) === baseKey) return true;
        }
        // basename 为 .env / .env.xxx / .envrc（.env.local / .env.production …）
        // 注意：用 ".env." 前缀而非 ".env" 开头，避免误伤 .environment.md 这类合法文件（与 bridge-server 侧口径一致）
        // 短名形态：ENV~1（键 "env|"）/ ENV~1.LOC（键 "env|loc"）——键以 "env|" 开头即命中；
        // .envrc 短名 ENVRC~1 键 "envrc|" 单列（不以 "env|" 开头）。.environment.md 短名
        // 键 "enviro|md" 不受影响。
        if (base === ".env" || base.indexOf(".env.") === 0 || base === ".envrc") return true;
        if (baseKey && (baseKey.indexOf("env|") === 0 || baseKey === "envrc|")) return true;
        // basename 以 .pem / .key 结尾（短名扩展保留 3 字符，此后缀规则天然覆盖短名形态）
        if (base.length >= 4 && base.substring(base.length - 4) === ".pem") return true;
        if (base.length >= 4 && base.substring(base.length - 4) === ".key") return true;
            // .pfx（PKCS#12 客户端证书/私钥容器）：面板 aefs 与桥侧都有，AE 侧同样拦截。
            if (base.length >= 4 && base.substring(base.length - 4) === ".pfx") return true;
    }
    return false;
}

// AE 侧「系统目录/盘根」谓词 —— 面板侧 client/shared/aefs.js 的 _isSystemOrRootDir 的**镜像**
// （同语义、不重新发明规则；两份实现逐例一致的 parity 断言见
//  parity 用例集——改本函数前先跑它，
//  面板侧那份是权威判据）。
// 用途限定：**写/删方向**的守卫（file 域授权分支的 open 写模式 / remove / rename / copy /
// create）。读方向（open("r") / readFile）**不接**本谓词——读侧既有语义只拦凭据
// （_isSensitivePath），收紧读会误伤既有用途（明确不做）。
// 判据（与面板侧逐条对应；面板侧消费点 aefs.js 的 writeFileLlm → 拒因 system_dir）：
//   ① 段级归一化：剥每段尾随的 . 与空格（Win32 路径落盘语义），纯点/空格段过滤
//   ② 任意段为 8.3 短名（/^[a-z0-9]{1,6}~[0-9]{1,2}$/）→ 拒（解析后可能指向系统目录）
//   ③ 任意段为 windows.old / system volume information → 拒
//   ④ depth===0（盘根）或 /^[a-z]:$/（盘符本身）→ 拒
//   ⑤ **首段**为 windows / program files / program files (x86) / programdata → 拒
//      （段名判据、不绑盘符：D:\windows\x 与 C:\Windows\x 同判；windows 非首段不算）
//   ⑥ 首段为 users 且 depth<=2 → 拒（只挡 C:\Users 与 C:\Users\<profile>，不挡其下深处）
// ES3：面板侧用 map/filter，此处改 for 循环（ExtendScript 无 ES5 数组方法）。
function _isSystemOrRootDir(p) {
    // 归一化对齐面板侧 _toFwd：剥 file:/// 前缀、盘符竖线形态（D|/x）转冒号、
    // 反斜杠转正斜杠、小写、压缩连续斜杠
    var fwd = String(p === null || p === undefined ? "" : p)
        .replace(/^file:\/+/i, "").replace(/\|/g, ":").replace(/\\/g, "/").toLowerCase();
    fwd = fwd.replace(/\/+/g, "/");
    var stripped = fwd.replace(/^[a-z]:\//, "");
    var rawSegs = stripped.split("/");
    var segs = [], i;
    for (i = 0; i < rawSegs.length; i++) {
        var s = rawSegs[i].replace(/[. ]+$/, "");
        if (s) segs.push(s);
    }
    var depth = segs.length;
    // 8.3 短名段（progra~1 / window~1 形态）直接视为不安全
    for (i = 0; i < segs.length; i++) {
        if (/^[a-z0-9]{1,6}~[0-9]{1,2}$/.test(segs[i])) return true;
    }
    for (i = 0; i < segs.length; i++) {
        if (segs[i] === "windows.old" || segs[i] === "system volume information") return true;
    }
    // 【必须显式加括号】AE 内实测：ExtendScript 的 `&&` 与 `||` **同优先级、
    // 从左到右**（标准 JS 里 `&&` 更紧）。原写法 `|| segs[0] === "users" && depth <= 2`
    // 被解析成「整条链 && depth<=2」→ 上面所有**首段**规则只在 depth<=2 时生效
    //（实测：C:\Windows\System32\x 深度 3 漏拦、C:\Windows\x 深度 2 拦住；
    //  windows.old / System Volume Information / 8.3 这类**任意段**规则在下方小 if 之前
    //  已 return，不受影响）。面板侧同一份逻辑跑在 Chrome（标准优先级）无此问题——
    // 这正是「AE 侧镜像 + Node 侧 parity 测试」抓不到它的原因。
    // 该约束由回归固定：jsx 内混用 `&&`/`||` 且未加括号即报错。
    if (depth === 0
        || /^[a-z]:$/.test(fwd)
        || segs[0] === "windows"
        || segs[0] === "program files"
        || segs[0] === "program files (x86)"
        || segs[0] === "programdata"
        || (segs[0] === "users" && depth <= 2)) {
        return true;
    }
    return false;
}


// ── 渲染输出便捷函数已删 ────────────────────────────
// addToRenderQueue / startRender / _rqFormatPatterns / _rqMatchTemplate / _rqProbeArtifact /
// _rqOutputModuleName 六件已随之删除；渲染改走原生 app.project.renderQueue + q.render()
//（guideContent.js ⑥ 同步）。_rqStatusName 保留——getRenderQueueInfo 用它把 RQItemStatus
// 数字码映射成小写语义名。






// ── saveProject：参数式保存工程 ──────────────────────────────
// 背景：删除自实现的 saveProject 宿主函数、只放开原生
// `app.project.save([file])` 之后，file 域关时 LLM 仍**无法另存**——save 的 file
// 参数只能来自 `new File(...)`（挂 file 域闸、fail-closed）或 `app.project.file`
// （只指向已保存过的工程文件）。外接会话实测：`new File(...)` 被门拒 → 只能求用户
// 开 file 域。本工具把路径改成**参数**（宿主侧构造 File），恢复「四域全关也能另存」；
// 不恢复按名调用的库函数形态（LLM 不写 `new File`，门表不动）。
// 语义：① 带 filePath → 另存到该路径；② 不带 filePath → 仅当工程已保存过时存回
// 原路径；**从未保存过**（`app.project.file` 为空）→ 直接回结构化错误，一次 AE
// 调用都不发（零参 `app.project.save()` 在该状态下会弹「另存为」模态或报错，
// 无人值守通道弹模态会挂起 AE）。
// 产物核查（分档）：保存前目标不存在 → 保存后必须存在且非 0 字节；
// 保存前已存在 → 要求 size 或 mtime 变化，否则回「未确认落盘」错误（不报 success）。
function _savedArtifactState(f) {
    var st = { exists: false, len: -1, mtime: -1 };
    try {
        st.exists = f.exists ? true : false;
        if (st.exists) {
            st.len = Number(f.length);
            var d = f.modified;
            st.mtime = d ? Number(d.getTime()) : -1;
        }
    } catch (_) { /* 探测失败按 -1 走分档判据 */ }
    return st;
}

// 保存前落盘预检：系统目录/盘根、不存在或不可写目录在调用 app.project.save 之前拒绝。
// AE 对不可写目标会弹原生「无法创建文件」模态并阻塞 ExtendScript 通道；_checkPath 只挡
// 相对/穿越路径、_isSensitivePath 只挡凭据类文件，均不覆盖系统目录。
// 判定顺序：系统目录/盘根 → 目标目录存在 → 目录写权限（建删临时探针文件；File.open('w')
// 在无权限时返回 false，不弹模态）。探针抛异常与返回 false 语义不同：工具模板在守卫
// 窗口内执行，file 域关闭时 File.prototype.open 的写模式是 throw 版——抛异常表示
// 「无法核实目录写权限」而非不可写，此时放行并交回原保存流程；只有 open()===false
// 才判不可写（file 域关闭时预检因此退化为不检查，原生模态风险由 AE 侧承担）。探针
// 用固定文件名，避免每次另存残留不同文件；删除失败时留待下次覆盖。
function _preflightSaveTarget(f) {
    if (!f || !f.fsName) return { ok: false, reason: "目标文件对象为空" };
    var fp = String(f.fsName);
    if (_isSystemOrRootDir(fp)) return { ok: false, reason: "系统目录或盘根不可写: " + fp };
    var parent = null;
    try { parent = f.parent || null; } catch (_) { parent = null; }
    if (!parent || typeof parent.fsName !== "string" || !parent.fsName) {
        return { ok: true };   // 旧环境/宽松 mock：无 parent 能力，跳过目录探针
    }
    if (parent.fsName === fp) return { ok: false, reason: "目标路径无效（指向盘符根）: " + fp };
    if (!parent.exists) return { ok: false, reason: "目标目录不存在: " + parent.fsName };
    var probe = null;
    var opened = false;
    try {
        probe = new File(parent.fsName + "/.ae_llm_save_probe");
    } catch (_) {
        return { ok: true };   // 无法建探针（守卫/宿主限制）→ 交回原保存流程
    }
    try {
        opened = probe.open("w");
    } catch (_) {
        // 守卫窗口内写模式 open 为 throw 版：无法核实，放行（不能误判为不可写）
        return { ok: true };
    }
    if (!opened) return { ok: false, reason: "目标目录不可写: " + parent.fsName };
    try { probe.close(); } catch (_) {}
    try { probe.remove(); } catch (_) {}
    return { ok: true };
}

function saveProject(args) {
    try {
        var filePath = (args && args.filePath !== undefined && args.filePath !== null) ? String(args.filePath) : "";
        var current = null;
        try { current = app.project.file; } catch (_) { current = null; }
        var target = null;
        var mode = "save";
        if (filePath) {
            if (!_checkPath(filePath)) throw new Error("Invalid or unsafe path: " + filePath);
            if (_isSensitivePath(filePath)) throw new Error("敏感路径，已拒写: " + filePath);
            target = new File(filePath);
            mode = "saveAs";
            // 系统目录/不可写目录前置拒绝（AE 原生模态会阻塞通道）
            var _pf = _preflightSaveTarget(target);
            if (!_pf.ok) throw new Error("目标路径不可保存：" + _pf.reason);
        } else {
            if (!current) {
                return {
                    status: "error",
                    message: "工程从未保存过：零参 app.project.save() 会弹「另存为」模态（或报错）。替代：saveProject({filePath: \"D:/项目/工程.aep\"}) 另存，或用户手动保存一次后重试。",
                    projectFile: null
                };
            }
            target = current;
            mode = "save";
        }
        var pre = _savedArtifactState(target);
        var okFlag = true;
        try {
            okFlag = app.project.save(target);
        } catch (e) {
            return { status: "error", message: "app.project.save() 抛错: " + e.toString(), projectFile: (function () { try { return app.project.file ? app.project.file.fsName : ""; } catch (_) { return ""; } })() };
        }
        // 保存后 stat 必须新建 File 对象：复用保存前对象的 length/modified 是陈旧快照，
        // 会把成功保存误判成「size 与 mtime 均未变」。
        var post = _savedArtifactState(new File(target.fsName));
        var savedPath = "";
        try { savedPath = app.project.file ? app.project.file.fsName : ""; } catch (_) { savedPath = ""; }
        var base = { mode: mode, savedPath: savedPath, projectFile: savedPath };
        if (okFlag === false) {
            base.status = "error";
            base.message = "app.project.save() 返回 false（保存失败）";
            return base;
        }
        if (!post.exists) {
            base.status = "error";
            base.message = "保存未确认落盘：目标文件不存在";
            base.verified = false;
            return base;
        }
        if (!pre.exists) {
            if (post.len <= 0) {
                base.status = "error";
                base.message = "保存未确认落盘：新产物为 0 字节";
                base.verified = false;
                return base;
            }
        } else if (post.len === pre.len && post.mtime === pre.mtime) {
            base.status = "error";
            base.message = "保存未确认落盘：文件存在，size 与 mtime 均未变";
            base.verified = false;
            return base;
        }
        base.status = "success";
        base.message = (mode === "saveAs") ? "Project saved as" : "Project saved";
        base.verified = true;
        base.bytes = post.len;
        return base;
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

// 分层文件扩展名：auto 模式下按合成导入。其余扩展名一律不设置 importAs，
// 保留 ImportOptions 默认类型（.aep 等非素材类型依赖默认导入）。
function _importLayeredExt(filePath) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(filePath || ""));
    if (!m) return false;
    var ext = m[1].toLowerCase();
    return ext === "psd" || ext === "psb";
}

// 把归一后的导入方式写入 ImportOptions.importAs。AE 无按图层选择 API，
// 需要按合成导入的文件只能经 importAs 选导入类型；设值前必须 canImportAs（官方要求，选错类型会抛错）。
// strict=true（调用方显式指定）：不能按合成导入时抛错；false（auto）：静默回退 footage。
// 返回实际采用的方式（footage/comp/compCropped）。
function _applyImportMode(importOpts, mode, strict) {
    if (mode === "footage") return "footage";
    var wantCropped = (mode === "compCropped");
    var typeValue = null;
    try { typeValue = wantCropped ? ImportAsType.COMP_CROPPED_LAYERS : ImportAsType.COMP; } catch (_) { typeValue = null; }
    if (typeof typeValue !== "number") {
        if (strict) throw new Error("当前 AE 不支持 ImportAsType 枚举，无法指定导入方式；改用 importAs:'footage'");
        return "footage";
    }
    var canAs = false, canAsErr = null;
    try {
        canAs = (typeof importOpts.canImportAs === "function") && importOpts.canImportAs(typeValue) === true;
    } catch (canErr) { canAs = false; canAsErr = canErr; }
    if (!canAs) {
        if (strict) {
            if (canAsErr) throw new Error("导入方式预检失败（canImportAs 抛错）：" + canAsErr.toString());
            throw new Error("该文件不能按" + (wantCropped ? "合成-裁剪图层" : "合成") + "导入（canImportAs 为 false）；改用 importAs:'footage' 作为单条素材导入");
        }
        return "footage";
    }
    try {
        importOpts.importAs = typeValue;
    } catch (setErr) {
        if (strict) throw new Error("设置 importAs 失败：" + setErr.toString());
        return "footage";
    }
    return mode;
}

function importFile(args) {
    try {
        var filePath = args.filePath || "";
        if (!filePath) throw new Error("Must provide filePath");
        if (!_checkPath(filePath)) throw new Error("Invalid or unsafe path: " + filePath);
        if (_isSensitivePath(filePath)) throw new Error("敏感路径，已拒读: " + filePath);
        var f = new File(filePath);
        if (!f.exists) throw new Error("File not found: " + filePath);
        var asSequence = !!args.asSequence;
        // importAs：auto（默认）/ footage / comp / compCropped；大小写与首尾空白不敏感
        var mode = "auto";
        if (args.importAs !== undefined && args.importAs !== null) {
            if (typeof args.importAs !== "string") throw new Error("importAs 必须是字符串（合法值：auto / footage / comp / compCropped）");
            var rawMode = args.importAs.replace(/^\s+|\s+$/g, "").toLowerCase();
            if (rawMode === "" || rawMode === "auto") mode = "auto";
            else if (rawMode === "footage") mode = "footage";
            else if (rawMode === "comp") mode = "comp";
            else if (rawMode === "compcropped") mode = "compCropped";
            else throw new Error("importAs 非法值：" + args.importAs + "（合法值：auto / footage / comp / compCropped）");
        }
        var importOpts = new ImportOptions(f);
        if (args.asSequence !== undefined) {
            try { importOpts.sequence = asSequence; } catch (_) {}
        }
        // 序列导入只能作为单条素材：与显式合成导入互斥；auto 遇序列时直接按素材。
        var requestedMode = "footage";
        if (mode === "comp" || mode === "compCropped") {
            if (asSequence) throw new Error("asSequence 与 importAs='" + mode + "' 互斥：序列只能按素材导入");
            requestedMode = _applyImportMode(importOpts, mode, true);
        } else if (mode === "auto" && !asSequence && _importLayeredExt(filePath)) {
            requestedMode = _applyImportMode(importOpts, "comp", false);
        }
        var imported = app.project.importFile(importOpts);
        if (!imported) throw new Error("Import failed for: " + filePath);
        // 回执按实际返回对象报导入类型（AE 可能把合成导入静默降级成素材；
        // 项目导入等默认类型既不是合成也不是素材，报 other/default 而不是 footage）。
        var itemType = "other";
        try {
            if (imported instanceof CompItem) itemType = "comp";
            else if (imported instanceof FootageItem) itemType = "footage";
        } catch (_) { itemType = "other"; }
        var actualMode;
        if (itemType === "comp") actualMode = (requestedMode === "compCropped") ? "compCropped" : "comp";
        else if (itemType === "footage") actualMode = "footage";
        else actualMode = "default";
        var receipt = {
            status: "success",
            message: (itemType === "comp") ? "Imported as composition"
                : ((itemType === "footage") ? "File imported" : "File imported (default import type)"),
            importAs: actualMode,
            asSequence: asSequence,
            item: {
                name: imported.name,
                type: itemType,
                index: (function () { try { return _getItemIndex(imported); } catch (_) { return 0; } })(),
                id: _readItemId(imported)
            }
        };
        if ((itemType === "comp" || itemType === "footage") && actualMode !== requestedMode) {
            receipt.requestedImportAs = requestedMode;
        }
        if (itemType === "comp") {
            var layerCount = 0;
            try { layerCount = Number(imported.layers.length); } catch (_) { layerCount = 0; }
            receipt.layers = layerCount;
        }
        return receipt;
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

function replaceFootage(args) {
    try {
        var name = args.itemName || "";
        var index = args.itemIndex !== undefined ? Number(args.itemIndex) : 0;
        var newPath = args.newFilePath || args.newPath || "";
        if (!newPath) throw new Error("Must provide newPath");
        if (!_checkPath(newPath)) throw new Error("Invalid or unsafe path: " + newPath);
        if (_isSensitivePath(newPath)) throw new Error("敏感路径，已拒读: " + newPath);
        var newFile = new File(newPath);
        if (!newFile.exists) throw new Error("Replacement file not found: " + newPath);
        var item = null;
        if (index > 0 && index <= app.project.numItems) item = app.project.item(index);
        else if (name) {
            for (var i = 1; i <= app.project.numItems; i++) {
                if (app.project.item(i).name === name) { item = app.project.item(i); break; }
            }
        }
        if (!item) throw new Error("Project item not found");
        if (!(item instanceof FootageItem)) throw new Error("Item is not a footage item: " + item.name);
        item.replace(newFile);
        return { status: "success", message: "Footage replaced", itemName: item.name, newPath: newPath };
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}




// ── 关键帧曲线读写（函数本体已删）────────
// API 依据：AE 脚本指南 Property 关键帧族 + KeyframeEase（签名逐条核对官方文档）。
// 维度语义为本机 AE 实测：时间缓动数组长度 ThreeD=3（Scale）/ ThreeD_SPATIAL=1
// （Position、Anchor Point）/ OneD=1（Rotation、Opacity）/ SHAPE=1（Mask Path）；
// 空间切线维度 ThreeD_SPATIAL=3。本版本 String(枚举) 返回数字、PropertyType.PROPERTY_GROUP
// 为 undefined，故枚举比较一律走数值常量，不做字符串比较。
// 下面两张表是本机 AE 枚举数值的**全仓唯一记录**（client/shared/aeApiReference.txt 只列枚举
// 名、无数字）。其消费者（getKeyframeCurve / setKeyframeCurve 与 16 个私有 helper）已删，
// 表本身保留供日后重做原生关键帧/缓动路径取值；两名均登在 _INTERNAL_NAMES 内，用户脚本按名
// 不可达。
var _PV_FALLBACK = { NO_VALUE: 6412, OneD: 6417, TwoD: 6416, ThreeD: 6414, COLOR: 6418, TwoD_SPATIAL: 6415, ThreeD_SPATIAL: 6413, SHAPE: 6423 };
var _KI_FALLBACK = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };


function getEffectInfo(args) {
    try {
        args = args || {};
        // 合成/图层定位：不再经 getLayerTarget →
        // getActiveComp 的 `Number(...)` + `Math.floor(...)` 归一（true→1、"1"→1、1.5→1、0
        // 退回活动合成，合成查错却收到 success）。
        // compName：按名选合成不可靠，静默忽略会让调用方以为按名选中——
        // 查到的却是活动合成。名字会随改名漂移，能定位的只有 id/索引；这里显式报错，不回退。
        // 合成：与 target=comp/layer 共用 _resolveStrictComp（compositionId 优先，其次
        // compositionIndex/compIndex；两个键都没给时回退活动合成——effect 的既有行为）。
        // 图层：layerIndex 必须 number 正整数且在 1..numLayers；layerId 同款正整数 + 必须属于
        // 该合成；layerName 子串匹配、大小写不敏感（与 target=layer 同一语义）。
        if (args.compName !== undefined && args.compName !== null) {
            return { status: "error", message: "compName 不再支持，请用 compositionId 或 compositionIndex 指定合成" };
        }
        var _rcFxComp = _resolveStrictComp(args, true);
        if (_rcFxComp.error) return { status: "error", message: _rcFxComp.error };
        var comp = _rcFxComp.comp;
        var layer = null;
        if (args.layerId !== undefined && args.layerId !== null) {
            // 与 layerIds 元素同一契约（number 或纯数字字符串的正整数）：布尔/浮点/空串报错，
            // 不做 Math.floor(Number(...)) 归一（true→1、1.5→1 会定位到别的层）。
            var fxIdRaw = args.layerId;
            var fxLayerId = NaN;
            if (typeof fxIdRaw === "number") fxLayerId = fxIdRaw;
            else if (typeof fxIdRaw === "string" && /^\d+$/.test(fxIdRaw)) fxLayerId = Number(fxIdRaw);
            if (!isFinite(fxLayerId) || fxLayerId !== Math.floor(fxLayerId) || fxLayerId < 1) {
                return { status: "error", message: "layerId 必须是正整数（收到 " + String(fxIdRaw) + "）" };
            }
            layer = _findLayerById(comp, fxLayerId);
            if (!layer) {
                return { status: "error", message: "Layer id not found in comp \"" + comp.name + "\" (deleted or moved?): " + fxLayerId };
            }
        } else if (args.layerIndex !== undefined && args.layerIndex !== null) {
            if (typeof args.layerIndex !== "number" || !isFinite(args.layerIndex) ||
                args.layerIndex !== Math.floor(args.layerIndex) || args.layerIndex < 1) {
                return { status: "error", message: "layerIndex 不是正整数索引: " + String(args.layerIndex) };
            }
            if (args.layerIndex > comp.numLayers) {
                return { status: "error", message: "layerIndex 越界: " + args.layerIndex + "（本合成图层数 " + comp.numLayers + "）" };
            }
            layer = comp.layer(args.layerIndex);
        } else if (args.layerName) {
            // 子串 + 大小写不敏感（与 target=layer 的 layerName 过滤同口径）：
            // 全等比较，大小写/中文差异下同名层查不到，两个 target 的行为还不一致。
            var fxLayerName = String(args.layerName).toLowerCase();
            for (var fli = 1; fli <= comp.numLayers; fli++) {
                var fliName = "";
                try { fliName = String(comp.layer(fli).name).toLowerCase(); } catch (_) { fliName = ""; }
                if (fliName.indexOf(fxLayerName) >= 0) { layer = comp.layer(fli); break; }
            }
            if (!layer) return { status: "error", message: "Layer not found: " + String(args.layerName) };
        } else {
            return { status: "error", message: "需要 layerIndex 或 layerId（或 layerName）" };
        }
        var effectName = args.effectName || "";
        // effectIndex 严格：必须 number 正整数且在 1..numProperties。若按 `Number` 归一，
        // `Number(args.effectIndex)` 让 true→1、"1"→1、1.5→1 静默选中别的效果；越界又静默
        // 回退 effectName。index 与 name 同给时 index 优先（seed 契约），index 无效直接报错。
        var effectIndexGiven = (args.effectIndex !== undefined && args.effectIndex !== null);
        var effectIndex = 0;
        if (effectIndexGiven) {
            if (typeof args.effectIndex !== "number" || !isFinite(args.effectIndex) ||
                args.effectIndex !== Math.floor(args.effectIndex) || args.effectIndex < 1) {
                return { status: "error", message: "effectIndex 不是正整数索引: " + String(args.effectIndex) };
            }
        }
        var effects = getPropSafe(layer, "Effects");
        if (!effects || effects.numProperties === 0) throw new Error("No effects on layer: " + layer.name);
        if (effectIndexGiven) {
            if (args.effectIndex > effects.numProperties) {
                return { status: "error", message: "effectIndex 越界: " + args.effectIndex + "（本效果组属性数 " + effects.numProperties + "）" };
            }
            effectIndex = args.effectIndex;
        }
        var eff = null;
        // 选择器缺失与选择器未命中分开报：target=effect 是文档化入口，缺参数时应指明缺哪一个
        if (!effectIndexGiven && !effectName) throw new Error("需要 effectName 或 effectIndex（1-based）");
        if (effectIndexGiven) eff = effects.property(effectIndex);
        else eff = findEffectByName(effects, effectName);
        if (!eff) throw new Error("Effect not found: " + (effectName || "index " + effectIndex));

        // —— 选项（缺省保持旧行为，新增项默认开）——
        // includeKeyframes：叶子属性带关键帧明细列表（keyframeList）；关掉只看数量。
        var includeKeyframes = args.includeKeyframes !== false;
        // 关键帧窗口：单属性关键帧数没有天然上限（实测 3000 键 → 响应
        // ≈512KB，超 agent 管线 32K 截断线后 JSON.parse 失败），所以每个叶子只序列化
        // [keyframeOffset, keyframeOffset + keyframeLimit) 这一窗。默认 0 / 100，上限 200；
        // 叶子另给 keyframesTotal（真实总数）与 keyframesHasMore 供续页。
        // 关键帧窗口（下限 1）：0.5 floor 成 0 → 本页 keyframes=0 而
        // keyframesHasMore=true，调用方按公式续页永远原地（同型死循环）。
        var keyframeOffset = (typeof args.keyframeOffset === "number" && isFinite(args.keyframeOffset) && args.keyframeOffset > 0)
            ? Math.floor(args.keyframeOffset) : 0;
        var keyframeLimit = (typeof args.keyframeLimit === "number" && isFinite(args.keyframeLimit) && args.keyframeLimit > 0)
            ? Math.max(1, Math.floor(args.keyframeLimit)) : 100;
        if (keyframeLimit > 200) keyframeLimit = 200;
        var includeExpression = args.includeExpression !== false;
        var atTime = (typeof args.atTime === "number" && isFinite(args.atTime)) ? args.atTime : null;
        var filter = args.propertyFilter ? String(args.propertyFilter).toLowerCase() : "";
        // propertyOffset：纯数字字符串按 number 处理——只认 typeof number 时，
        // propertyOffset:"30" 静默当 0，groupPath 的冲突检查因此被绕过（组模式里调用方以为
        // 收窄了顶层属性，实际什么都没发生）。非数字串/非有限/≤0 仍回退 0。
        var offset = 0;
        if (typeof args.propertyOffset === "number" && isFinite(args.propertyOffset) && args.propertyOffset > 0) {
            offset = Math.floor(args.propertyOffset);
        } else if (typeof args.propertyOffset === "string" && /^[0-9]+$/.test(args.propertyOffset)) {
            var _poNum = Number(args.propertyOffset);
            if (isFinite(_poNum) && _poNum > 0) offset = Math.floor(_poNum);
        }
        // 下限 1：propertyLimit 0.5 → 空页 + hasMore=true（同上死循环）
        var limit = (typeof args.propertyLimit === "number" && isFinite(args.propertyLimit) && args.propertyLimit > 0)
            ? Math.max(1, Math.floor(args.propertyLimit)) : 40;
        if (limit > 200) limit = 200;   // 上限：大效果（AS_Effect Host 有百余项参数）单次全会撞客户端结果预算
        // 节点预算：group 递归展开的总条目上限（分页只管顶层，嵌套组不吃分页）。
        // 上限 500（原 2000）：2000 节点响应实测 ≈399KB，而 agent 管线在
        // 32K 字符处截断（头 24K + 尾 8K）→ JSON 解析失败退化成文本。500 只是兜底硬顶，
        // 实际先撞的是下面的字节预算。
        var nodeBudget = (typeof args.maxNodes === "number" && isFinite(args.maxNodes) && args.maxNodes > 0)
            ? Math.max(1, Math.floor(args.maxNodes)) : 300;
        if (nodeBudget > 500) nodeBudget = 500;
        var nodesUsed = 0;
        // 字节预算：每个节点按其 JSON 估算长度累加（叶子含 value/
        // expression/keyframeList，组含自身骨架），到顶就停止展开。取 16000：agent 管线 32K
        // 截断前有 24K 头预算，留出响应外框与中文多字节余量后仍能整体解析。
        // 与 nodeBudgetExhausted 并列：两种预算各自独立置标记，语义都是「真的少输出了节点」。
        var BYTE_BUDGET = 16000;
        // 组分支会调用 describeProp（函数声明提升），它累加的 bytesUsed 必须先于调用初始化；
        // NODE_SHRINK_LIMITS 同理由 chargeNode 读取，而组分支的子树可能在顶层流程之前就触发
        // chargeNode（var 只提升声明不提升赋值，留到后面声明会读到 undefined）。
        var bytesUsed = 0;
        var bytesTruncated = false;
        var nodesTruncated = false;
        var NODE_SHRINK_LIMITS = [20, 10, 5, 1];
        // 嵌套组续读：组子循环 break 只置 childrenTruncated 时，
        // nextOffset/hasMore 只续顶层——组内 400 个叶子时 properties.length=1、children≈81、
        // hasMore=false，剩余子项没有任何续读路径。groupPath 用点分 0-based 索引直接指向
        // 某个组（如 "2.0.1"，从效果顶层起），groupOffset/groupLimit 只展开该组的子窗口。
        var groupPathArg = null;
        if (args.groupPath !== undefined && args.groupPath !== null) {
            if (typeof args.groupPath !== "string" || !/^\d+(\.\d+)*$/.test(args.groupPath)) {
                return { status: "error", message: "groupPath 需为点分 0-based 索引串（如 \"2.0.1\"）: " + String(args.groupPath) };
            }
            groupPathArg = args.groupPath;
        }
        if (groupPathArg !== null) {
            // groupPath 模式只展开该组：propertyFilter/propertyOffset 是**顶层**属性语义
            //（过滤/分页顶层列表），组模式下静默忽略会让调用方以为收窄了结果面
            //（实测 {groupPath:"0", propertyFilter:"zzz"} 仍回 p1..p50、
            // propertyOffset:30 仍从 p1 开始）。组内分页只有 groupOffset/groupLimit，
            // 所以这里显式拒绝而不是忽略。
            var _gFilter = (args.propertyFilter !== undefined && args.propertyFilter !== null)
                ? String(args.propertyFilter) : "";
            if (_gFilter !== "") {
                return { status: "error", message: "groupPath 模式不支持 propertyFilter（仅顶层属性生效；组内请用 groupOffset）" };
            }
            // 复用上面已解析的顶层 offset（含纯数字字符串归一）：不做这一步时只认
            // typeof number，propertyOffset:"30" 在这里被当成 0，冲突检查被静默绕过。
            if (offset > 0) {
                return { status: "error", message: "groupPath 模式不支持 propertyOffset（仅顶层属性分页生效；组内请用 groupOffset）" };
            }
            // 节点预算下限：maxNodes=1 时组节点自身就吃掉全部预算，本页 0 子项、
            // nextGroupOffset 原地不动却 groupHasMore=true（续页死循环，与
            // keyframes=0 + hasMore=true 同型）。组模式按至少 2 个节点计：组 + 至少 1 个子项，
            // 保证 nextGroupOffset 每页前进；真的一个子项都放不下时下面置 groupEmptyPage。
            if (nodeBudget < 2) nodeBudget = 2;
            var gNode = eff;
            var gSegs = groupPathArg.split(".");
            for (var gsi = 0; gsi < gSegs.length; gsi++) {
                var gIdx = Number(gSegs[gsi]);
                var gNext = null;
                try { gNext = gNode.property(gIdx + 1); } catch (_) { gNext = null; }
                if (!gNext) return { status: "error", message: "groupPath 第 " + (gsi + 1) + " 段索引不存在: " + gIdx };
                gNode = gNext;
            }
            if (!isGroup(gNode)) return { status: "error", message: "groupPath 指向的不是组: " + groupPathArg };
            var gTotal = 0;
            try { gTotal = Number(gNode.numProperties) || 0; } catch (_) { gTotal = 0; }
            var groupOffset = (typeof args.groupOffset === "number" && isFinite(args.groupOffset) && args.groupOffset > 0)
                ? Math.floor(args.groupOffset) : 0;
            // 下限 1：groupLimit 0.5 floor 成 0，响应回显 groupLimit:0 且
            // describeProp 把 0 当「未给」→ 一次返回全部子项（400 条），与实际窗口不符。
            var groupLimit = (typeof args.groupLimit === "number" && isFinite(args.groupLimit) && args.groupLimit > 0)
                ? Math.max(1, Math.floor(args.groupLimit)) : limit;
            if (groupLimit > 200) groupLimit = 200;
            if (groupOffset > gTotal) groupOffset = gTotal;
            var gOut = describeProp(gNode, Number(gSegs[gSegs.length - 1]) + 1, groupPathArg, groupOffset, groupLimit);
            var gNextOff = groupOffset + ((gOut.children && gOut.children.length) ? gOut.children.length : 0);
            // 兜底：本页 0 子项且后面还有子项时，绝不同时给 groupHasMore=true +
            // nextGroupOffset 不前进（调用方按 false 停；groupEmptyPage 明示是空页而非到底）。
            var gEmptyPage = false;
            if ((!gOut.children || gOut.children.length === 0) && groupOffset < gTotal) {
                gEmptyPage = true;
                gNextOff = groupOffset;
            }
            var gResult = {
                status: "success",
                // scope=group：本响应只展开 groupPath 指向的组，properties 恒为 1 条（该组节点），
                // 不再返回效果其它顶层属性；该组的子项仍在 children 数组里（结构不变）。
                scope: "group",
                layer: { index: layer.index, name: layer.name },
                compositionIndex: _getItemIndex(comp),
                effect: { name: eff.name, matchName: eff.matchName, index: eff.propertyIndex, enabled: eff.enabled },
                effectPropertyCount: eff.numProperties,
                properties: [gOut],
                propertyCount: 1,
                // 不输出 matchedCount：它是顶层属性过滤后的匹配总数语义，组模式下
                // 没有意义（恒 1 会让调用方以为这是过滤结果）；组模式只留 group* 字段。
                groupPath: groupPathArg,
                groupOffset: groupOffset,
                groupLimit: groupLimit,
                groupHasMore: gEmptyPage ? false : (gNextOff < gTotal),
                nextGroupOffset: gNextOff
            };
            if (gEmptyPage) gResult.groupEmptyPage = true;
            if (nodesTruncated) gResult.nodeBudgetExhausted = true;
            if (bytesTruncated) gResult.byteBudgetExhausted = true;
            if (atTime !== null) gResult.atTime = atTime;
            return gResult;
        }
        // 是否真的发生截断：只在尝试加入第 maxNodes+1 个节点、或给某个
        // 节点置了 childrenTruncated 时置位；恰好用满预算且无截断不算超出。

        // 节点的序列化长度估算（字节预算的计价单位：JSON.stringify 后的字符数）
        function nodeBytes(v) {
            try { return String(JSON.stringify(v)).length; } catch (_) { return 64; }
        }

        // 递归收集属性（效果属性可能嵌套 group，如 Lumetri 的二级面板）
        // 组判定与 shapeContents 同一判据：组是 INDEXED_GROUP/NAMED_GROUP（真机 6213/6214），
        // 叶子是 PROPERTY（6212）；PROPERTY_GROUP 宿主不存在，按它判恒假、嵌套组被当叶子。
        // 常量表缺失或仍不命中时退到 numProperties > 0（与 _fxCountAnimatedLeaves 同口径）。
        function isGroup(p) {
            var isG = false;
            try {
                if (p.propertyType === PropertyType.INDEXED_GROUP || p.propertyType === PropertyType.NAMED_GROUP) isG = true;
            } catch (_) { isG = false; }
            if (!isG) {
                try { if (Number(p.numProperties) > 0) isG = true; } catch (_) { isG = false; }
            }
            return isG;
        }
        function interpName(v) {
            try {
                if (v === KeyframeInterpolationType.LINEAR) return "linear";
                if (v === KeyframeInterpolationType.BEZIER) return "bezier";
                if (v === KeyframeInterpolationType.HOLD) return "hold";
            } catch (_) {}
            return String(v);
        }
        // 关键帧明细：时间/值/入出插值类型/入出速度与影响（曲线验证用）。
        // 按窗口序列化（from = 0-based 起始偏移，limit = 条数），不再一次拉全量。
        function keyframeList(p, from, limit) {
            var out = [];
            try {
                var n = p.numKeys;
                var startAt = from + 1;             // AE 关键帧序号 1-based
                var stopAt = from + limit;
                if (stopAt > n) stopAt = n;
                for (var i = startAt; i <= stopAt; i++) {
                    var kf = { time: p.keyTime(i), value: p.keyValue(i) };
                    try { kf.interpolationIn = interpName(p.keyInInterpolationType(i)); } catch (_) {}
                    try { kf.interpolationOut = interpName(p.keyOutInterpolationType(i)); } catch (_) {}
                    try {
                        var ie = p.keyInTemporalEase(i), oe = p.keyOutTemporalEase(i);
                        var ein = [], eout = [];
                        for (var a = 0; a < ie.length; a++) ein.push({ speed: ie[a].speed, influence: ie[a].influence });
                        for (var b = 0; b < oe.length; b++) eout.push({ speed: oe[b].speed, influence: oe[b].influence });
                        kf.easeIn = ein;
                        kf.easeOut = eout;
                    } catch (_) {}
                    out.push(kf);
                }
            } catch (_) {}
            return out;
        }
        // 叶子关键帧字段：只序列化当前窗口，另给总数与续页信号。
        // keyframes = 本页条数（未截断时等于 numKeys，旧语义不变）；includeKeyframes:false 时
        // 沿用旧行为只给数量（keyframes = numKeys，不带明细/窗口字段）。
        // keyframesTruncated = 本页不是全集（有键落在窗口之外），与 keyframesHasMore（还有后续页）分开。
        function fillKeyframes(d, p, kn) {
            var kOff = keyframeOffset;
            if (kOff > kn) kOff = kn;
            d.keyframesTotal = kn;
            if (!includeKeyframes) {
                d.keyframes = kn;
                return;
            }
            d.keyframeList = keyframeList(p, kOff, keyframeLimit);
            d.keyframes = d.keyframeList.length;
            d.keyframesOffset = kOff;
            d.keyframesLimit = keyframeLimit;
            d.keyframesHasMore = (kOff + d.keyframes) < kn;
            if (kOff > 0 || d.keyframesHasMore) d.keyframesTruncated = true;
        }
        // 单节点体积回判：字节预算只在节点构造**前**判，单个巨型节点
        //（3000 个关键帧 / 5000 顶点路径值）会整块塞进来，最终响应仍可到数百 KB。这里构造完
        // 再估一次，超 BYTE_BUDGET 就地收缩，保证任何单节点 ≤16KB。收缩顺序按「可选性优先、
        // 体积优先」（固定先丢关键帧/value 时，18KB 表达式叶子也被删了 1 字符的
        // value，70KB 的 valueAtTime 也先删 value）：
        //   ① expression：省略并给 expressionTruncated/expressionLength；
        //   ② valueAtTime：省略并给 valueAtTimeTruncated/valueAtTimeSize；
        //   ③ 关键帧窗口逐级压到 20/10/5/1 条（keyframesTruncated）；
        //   ④ 仍超限才省略 value（valueTruncated + valueType/valueSize，数组另给 valueLength，
        //      尽量给 valuePreview：截断短串/数组前几项）；
        //   ⑤ 最后才整段丢弃关键帧明细（keyframes=0、keyframesHasMore=false、
        //      keyframeDetailsDropped=true，只留 keyframesTotal）。
        // 返回实际计费字节数（调用方累加进 bytesUsed）。NODE_SHRINK_LIMITS 在上面的预算段声明。
        function valueKind(v) {
            if (v === null) return "null";
            if (_isArrayValue(v)) return "array";
            return typeof v;
        }
        // 省略 value 时的可读替身：短串/数组前几项；对象只认文本（源文本）的 text 字段。
        function previewValue(v) {
            try {
                if (typeof v === "string") return v.length > 200 ? v.substring(0, 200) : v;
                if (_isArrayValue(v)) {
                    var pn = v.length > 8 ? 8 : v.length;
                    var pv = [];
                    for (var pi = 0; pi < pn; pi++) pv.push(v[pi]);
                    return pv;
                }
                if (v === null || typeof v === "number" || typeof v === "boolean") return v;
                if (typeof v === "object" && typeof v.text === "string") {
                    return { text: v.text.length > 200 ? v.text.substring(0, 200) : v.text };
                }
            } catch (_) {}
            return undefined;
        }
        function chargeNode(d, p, kn) {
            var nb = nodeBytes(d);
            if (nb <= BYTE_BUDGET) return nb;
            // ① 表达式：体积最大、可选性最高（原文仍在 AE 里，明细可单独再查）
            if (d.expression) {
                d.expressionTruncated = true;
                d.expressionLength = String(d.expression).length;
                d.expression = "";
                nb = nodeBytes(d);
                if (nb <= BYTE_BUDGET) return nb;
            }
            // ② 指定时刻求值：与 value 同属可重算项，先于 value 丢弃
            if (d.valueAtTime !== undefined) {
                d.valueAtTimeTruncated = true;
                d.valueAtTimeType = valueKind(d.valueAtTime);
                d.valueAtTimeSize = nodeBytes(d.valueAtTime);
                delete d.valueAtTime;
                nb = nodeBytes(d);
                if (nb <= BYTE_BUDGET) return nb;
            }
            // ③ 关键帧窗口：先压条数（保留可续页的明细），不整段丢
            if (d.keyframeList && d.keyframeList.length > 0) {
                var kOff = d.keyframesOffset || 0;
                for (var s = 0; s < NODE_SHRINK_LIMITS.length; s++) {
                    var lim = NODE_SHRINK_LIMITS[s];
                    if (lim >= d.keyframeList.length) continue;
                    d.keyframeList = keyframeList(p, kOff, lim);
                    d.keyframes = d.keyframeList.length;
                    d.keyframesLimit = lim;
                    d.keyframesHasMore = (kOff + d.keyframes) < kn;
                    d.keyframesTruncated = true;
                    nb = nodeBytes(d);
                    if (nb <= BYTE_BUDGET) return nb;
                }
            }
            // ④ value：以上都缩完仍超限才省略，并尽量留可读预览
            if (d.value !== undefined) {
                d.valueTruncated = true;
                d.valueType = valueKind(d.value);
                d.valueSize = nodeBytes(d.value);
                if (_isArrayValue(d.value)) d.valueLength = d.value.length;
                var vPrev = previewValue(d.value);
                if (vPrev !== undefined) d.valuePreview = vPrev;
                delete d.value;
                nb = nodeBytes(d);
                if (nb <= BYTE_BUDGET) return nb;
            }
            // ⑤ 单键值/单值本身就超限：整段丢弃明细，且不再声称还能续页（否则调用方按
            // keyframesOffset+keyframes 原地打转；若保留 kn>kOff 的 hasMore，
            // 配合 keyframes=0 会得到「下一页还是这一页」）。
            if (d.keyframeList && d.keyframeList.length > 0) {
                d.keyframeList = [];
                d.keyframes = 0;
                d.keyframesLimit = 0;
                d.keyframesHasMore = false;
                d.keyframesTruncated = true;
                d.keyframeDetailsDropped = true;
                nb = nodeBytes(d);
            }
            return nb;
        }
        // 预算由调用方在**进入前**判：确认还余节点、还余字节才调用本函数，所以这里不再在入口
        // 置 nodesTruncated。若在入口判 nodesUsed >= nodeBudget 就置标记，0 子项的组恰好
        // 吃掉最后一格时也把 childrenTruncated/nodeBudgetExhausted 都置上，实际一个节点都没少。
        // path：从效果顶层起的 0-based 索引点分串（"2.0.1"），供 groupPath 续读；
        // childStart/childLimit 只在 group 分支显式续读时用（普通递归不传，展开全部剩余子项）。
        function describeProp(p, idx, pathStr, childStart, childLimit) {
            nodesUsed++;
            if (typeof pathStr !== "string" || pathStr === "") pathStr = String((typeof idx === "number" ? idx - 1 : 0));
            var d = { name: p.name, matchName: p.matchName, propertyIndex: p.propertyIndex, propertyType: String(p.propertyType), path: pathStr };
            try { d.enabled = p.enabled; } catch (_) {}
            if (isGroup(p)) {
                d.isGroup = true;
                d.children = [];
                var childTotal = 0;
                try { childTotal = Number(p.numProperties) || 0; } catch (_) { childTotal = 0; }
                var startAt = (typeof childStart === "number" && isFinite(childStart) && childStart > 0) ? Math.floor(childStart) : 0;
                if (startAt > childTotal) startAt = childTotal;
                // 子项上限下限 1：childLimit 与 groupLimit 同源；0 会让循环一条都不展开，
                // 组只剩骨架 + childrenHasMore=true，调用方按 nextGroupOffset 续页原地打转。
                var maxChildren = (typeof childLimit === "number" && isFinite(childLimit) && childLimit > 0)
                    ? Math.max(1, Math.floor(childLimit)) : childTotal;
                // 组只计自身骨架；子节点各自计（叶子含 value/expression/keyframeList）
                bytesUsed += nodeBytes(d);
                // 0 子项的组 numProperties=0：循环不执行，不置 childrenTruncated（无子项可截断）
                var childStopped = false;
                var childCosts = [];
                try {
                    for (var c = startAt + 1; c <= childTotal; c++) {
                        if (d.children.length >= maxChildren) { childStopped = true; break; }
                        if (nodesUsed >= nodeBudget) { childStopped = true; nodesTruncated = true; break; }
                        if (bytesUsed >= BYTE_BUDGET) { childStopped = true; bytesTruncated = true; break; }
                        var saveBytes = bytesUsed, saveNodes = nodesUsed;
                        var childNode = describeProp(p.property(c), c, pathStr + "." + (c - 1));
                        childCosts.push({ b: bytesUsed - saveBytes, n: nodesUsed - saveNodes });
                        d.children.push(childNode);
                    }
                } catch (_) {}
                // 组节点也守 16KB 上限：字节预算只在加子项**前**判，最后加进去的
                // 子项仍可把组节点顶到 16KB 之上（实测 400 叶子组 16153B）。这里回退尾部子项
                // 直到放得下；至少保留 1 个子项（单个巨型叶子无法再拆，交给它的 groupPath 或
                // 父层续读）。
                // 定界：叶子节点经 chargeNode 恒 ≤16KB；**组节点在只剩
                // 1 个接近上限的子项时可略超 16KB**，超出部分是组自身骨架（实测 <1KB），仍远低于
                // agent 管线的 32K 截断线。不为这点骨架再砍子项——砍掉等于丢数据且续页指针原地打转。
                // childrenTruncated 只表示该组本次没展开完（含 groupOffset>0 的前序未给），
                // childrenHasMore 才表示后面还有子项；childrenTotal 是真实 numProperties。
                // nextChildrenOffset = childrenOffset + 本页子项数：普通页里组被截断时
                // 它给出首跳偏移——否则调用方只有 groupPath 却没有起点（seed 让 groupOffset 取
                // "前一页的 nextGroupOffset"；普通页没有该字段就无从续读）。
                // 这几个截断字段本身也占字节，所以先挂字段、再按「含字段」的体积回退并
                // 逐轮刷新——按「未挂字段」的体积回退时，挂上后仍越线（400 叶子组实测 16005B）。
                var applyGroupMeta = function () {
                    if (startAt > 0 || childStopped || (startAt + d.children.length) < childTotal) {
                        d.childrenOffset = startAt;
                        d.childrenTotal = childTotal;
                        d.childrenHasMore = (startAt + d.children.length) < childTotal;
                        d.childrenTruncated = true;
                        d.nextChildrenOffset = startAt + d.children.length;
                    }
                };
                applyGroupMeta();
                while (d.children.length > 1 && nodeBytes(d) > BYTE_BUDGET) {
                    d.children.pop();
                    var droppedCost = childCosts.pop();
                    if (droppedCost) { bytesUsed -= droppedCost.b; nodesUsed -= droppedCost.n; }
                    childStopped = true;
                    bytesTruncated = true;
                    applyGroupMeta();
                }
                return d;
            }
            // 叶子属性：读值/关键帧/表达式
            var kn = 0;
            try { kn = Number(p.numKeys) || 0; } catch (_) { kn = 0; }
            try {
                if (kn > 0) {
                    d.value = p.value;
                    d.hasKeyframes = true;
                    fillKeyframes(d, p, kn);
                } else {
                    d.value = p.value;
                    d.hasKeyframes = false;
                }
            } catch (_) { d.value = null; }
            if (includeExpression) {
                try { d.expression = p.expression ? String(p.expression) : ''; } catch (_) {}
                try { d.expressionEnabled = !!p.expressionEnabled; } catch (_) {}
                // expressionError 非空串 = 该属性表达式当前求值失败（对齐官方 Property API）
                try { var ee = String(p.expressionError || ""); if (ee) d.expressionError = ee; } catch (_) {}
            }
            // 指定时间点求值：回读 t 时刻的真实值（时间重映射/表达式时变属性的值与
            // 当前值 p.value 不同——两者各有用途，故分别返回 value 与 valueAtTime）
            if (atTime !== null) {
                try {
                    d.valueAtTime = p.valueAtTime(atTime, false);
                    d.evaluatedAt = atTime;
                } catch (e2) {
                    d.evaluationError = e2.toString();
                }
            }
            try { d.canSetEnabled = p.canSetEnabled; } catch (_) {}
            // 计费前回判体积：单个巨型节点在这里收缩到 ≤16KB（见 chargeNode）
            bytesUsed += chargeNode(d, p, kn);
            return d;
        }

        // 顶层属性先过滤再分页（嵌套组递归不受分页影响、只受两种预算约束）。
        // 顶层循环同样吃预算——只在 describeProp 入口置标记、循环照跑时，
        // maxNodes 对顶层平铺属性完全无效（40 个叶子 maxNodes=1/5/10 都回 40 个节点）。
        // propertyOffset/propertyLimit 的顶层分页语义不变：本循环只覆盖返回页，预算在页内再截。
        var picked = [];
        try {
            for (var i = 1; i <= eff.numProperties; i++) {
                var p = eff.property(i);
                if (filter) {
                    var nm = String(p.name || "").toLowerCase();
                    var mm = String(p.matchName || "").toLowerCase();
                    if (nm.indexOf(filter) < 0 && mm.indexOf(filter) < 0) continue;
                }
                picked.push(i);
            }
        } catch (_) {}
        var totalMatched = picked.length;
        if (offset > totalMatched) offset = totalMatched;
        var endIdx = offset + limit;
        if (endIdx > totalMatched) endIdx = totalMatched;
        var props = [];
        for (var k = offset; k < endIdx; k++) {
            // 进入前判：本页还有下一个节点可输出，但预算已满 → 才是真截断（数组已到页尾不算）
            if (nodesUsed >= nodeBudget) { nodesTruncated = true; break; }
            if (bytesUsed >= BYTE_BUDGET) { bytesTruncated = true; break; }
            try { props.push(describeProp(eff.property(picked[k]), picked[k], String(picked[k] - 1))); } catch (_) {}
        }
        // 下一页偏移 = 本页起点 + 本页真正返回的顶层数（不是 offset+limit：预算 break 时
        // 实际条数更少，按 limit 加会跳过被截掉的属性）
        var nextOffset = offset + props.length;

        var out = {
            status: "success",
            layer: { index: layer.index, name: layer.name },
            compositionIndex: _getItemIndex(comp),
            effect: { name: eff.name, matchName: eff.matchName, index: eff.propertyIndex, enabled: eff.enabled },
            effectPropertyCount: eff.numProperties,
            properties: props,
            propertyCount: props.length,
            matchedCount: totalMatched,
            propertyOffset: offset,
            propertyLimit: limit,
            // hasMore 的语义是「还有未返回的匹配属性」，与是否因预算 break 无关。
            // 按 endIdx（= offset+limit）判，预算截断末页时会给出 hasMore=false，续页信号
            // 与数据相反：调用方按 false 停，丢掉的属性再也拿不到。
            hasMore: nextOffset < totalMatched,
            nextOffset: nextOffset
        };
        if (atTime !== null) out.atTime = atTime;
        // 只在真发生截断时置位（exact-fit 不置）：语义与 seed 的「超出时」一致。
        // 两种预算各自独立：节点用满置 nodeBudgetExhausted，字节用满置 byteBudgetExhausted。
        if (nodesTruncated) out.nodeBudgetExhausted = true;
        if (bytesTruncated) out.byteBudgetExhausted = true;
        if (args.propertyFilter) out.propertyFilter = String(args.propertyFilter);
        return out;
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}







// 效果列表分批遍历：供面板侧 effectsCache.js 分批生成缓存用。
// app.effects 索引单次 ~40ms（跨宿主），全量 1510 个 ≈ 60s 会卡死 AE，
// 故拆成小批（面板侧 setTimeout 串接，批间 AE 喘息）。
// offset 从 0 开始，limit 每批数量。返回 JSON 字符串：
//   { total, nextOffset, items:[{n:name, m:matchName, c:category}] }
// n/m/c 用短键减小序列化体积。
function getEffectsBatch(offset, limit) {
    try {
        offset = Number(offset) || 0;
        limit = Number(limit) || 20;
        if (offset < 0) offset = 0;
        if (limit < 1) limit = 1;
        if (limit > 200) limit = 200; // 硬上限，防误传大值卡死
        if (typeof app.effects === "undefined" || !app.effects || app.effects.length === 0) {
            return JSON.stringify({ total: 0, nextOffset: 0, items: [] });
        }
        var total = app.effects.length;
        var end = offset + limit;
        if (end > total) end = total;
        var items = [];
        // app.effects 是标准 JS Array（0-based），官方文档示例为 app.effects[12]
        for (var j = offset; j < end; j++) {
            try {
                var eff = app.effects[j];
                items.push({
                    n: String(eff.name || eff.displayName || ""),
                    m: String(eff.matchName || ""),
                    c: String(eff.category || "")
                });
            } catch (_) {}
        }
        return JSON.stringify({ total: total, nextOffset: end, items: items });
    } catch (e) {
        return JSON.stringify({ total: 0, nextOffset: offset, items: [], error: String(e) });
    }
}


function listFolderFiles(args) {
    try {
        var folderPath = String(args.folderPath || "");
        if (!folderPath) throw new Error("Must provide folderPath");
        if (!_checkPath(folderPath)) throw new Error("Invalid or unsafe path: " + folderPath);
        if (_isSensitivePath(folderPath)) throw new Error("敏感路径，已拒读: " + folderPath);
        var pattern = args.pattern || "";
        // maxResults 硬上限钳制（对齐 readFile maxChars 的 先例）——
        // 该参数由 LLM 控制，传 1e6 时大目录全量收集，结果体/上下文爆炸
        var maxResults = Number(args.maxResults) || 200;
        if (maxResults > 2000) maxResults = 2000;
        var folder = new Folder(folderPath);
        if (!folder.exists) return { status: "error", message: "Folder not found: " + folderPath };
        var allItems = folder.getFiles();
        // 计数与截断解耦。旧循环条件 `items.length < maxResults` 会在
        // 遍历中途 break，而 totalFiles/totalFolders 只累加了「已遍历前缀」却当总数返回——
        // 文件夹也占 items 名额，子文件夹多时最坏报 0 个文件；pattern 过滤后同样失真。
        // LLM 据这些数字向用户复述目录规模或判断「有没有 .psd」必然报错数。
        // 现改为：遍历中的 totalFiles/totalFolders 一律自增（全量真计数），仅 items.push
        // 前判 maxResults；返回 truncated 布尔如实标注条目是否被截断。
        // 全量遍历对超大目录会拖死 AE 主线程，故加「遍历安全上限」：只约束扫描条目数，
        // 不改 maxResults 的默认值/上限语义；触顶时停止遍历并置 scanLimitReached，
        // 此时总数本身只是前缀计数（不完整），truncated 一律为 true。
        var TOTAL_SCAN_LIMIT = 20000;
        var scanLimitReached = allItems.length > TOTAL_SCAN_LIMIT;
        var scanCount = scanLimitReached ? TOTAL_SCAN_LIMIT : allItems.length;
        var items = [];
        var totalFiles = 0;
        var totalFolders = 0;
        for (var i = 0; i < scanCount; i++) {
            var item = allItems[i];
            var name = String(item.displayName || item.name || "");
            if (item instanceof Folder) {
                totalFolders++;
                if (items.length < maxResults) {
                    items.push({ name: name, type: "folder", path: item.fsName || item.absoluteURI, uri: item.absoluteURI });
                }
            } else if (item instanceof File) {
                if (pattern) {
                    if (pattern.indexOf("*.") === 0) {
                        // *.ext 改后缀匹配——原子串匹配把 "archive.png.txt" 误命中 "*.png"
                        // 大小写不敏感（Windows 文件系统大小写不敏感，SHOT001.PNG
                        // 对 *.png 必须命中，两侧统一小写比对）
                        var ext = pattern.substring(1).toLowerCase();
                        var _suffixHit = (name.length >= ext.length
                            && name.substring(name.length - ext.length).toLowerCase() === ext);
                        if (!_suffixHit && (ext === ".png" || ext === ".jpg" || ext === ".jpeg")) {
                            // 真机：AE 渲染队列的图片序列产物名是「请求名 + 帧号」
                            // （X.png00000），后缀不等于 .png。对图片扩展名额外接受
                            // 「<ext> + 纯数字」结尾——否则 *.png 查不到刚渲染出的帧
                            //（真机实测回执 totalFiles:0 而文件实际存在）。
                            var _seqSuffix = new RegExp(ext.replace(".", "\\.") + "\\d+$");
                            _suffixHit = _seqSuffix.test(name.toLowerCase());
                        }
                        if (!_suffixHit) continue;
                    } else if (name.toLowerCase().indexOf(String(pattern).toLowerCase()) < 0) {
                        // 子串分支与 *.ext 后缀分支同口径折大小写。
                        // 不折大小写时 pattern:"shot" 命中不到 SHOT001.mov，回执 totalFiles:0
                        // 让用户/LLM 以为文件不存在（Windows 文件系统大小写不敏感）。
                        continue;
                    }
                }
                totalFiles++;
                if (items.length < maxResults) {
                    items.push({ name: name, type: "file", size: item.length, path: item.fsName || item.absoluteURI, modified: item.modified ? String(item.modified) : "" });
                }
            }
        }
        var result = { status: "success", folderPath: folderPath, items: items, totalFolders: totalFolders, totalFiles: totalFiles, truncated: items.length < totalFiles + totalFolders || scanLimitReached };
        if (scanLimitReached) {
            result.scanLimitReached = true;
            result.message = "目录条目超过遍历安全上限 " + TOTAL_SCAN_LIMIT + " 条，totalFiles/totalFolders 仅为已扫描前缀的计数（非完整总数）";
        }
        return result;
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

function getInstallPath(args) {
    try {
        var info = String(args.info || "root").toLowerCase();
        var installPath = "";
        var debugLog = [];

        // Strategy 1: app.path
        if (!installPath) {
            try {
                var p = app.path;
                if (p !== null && p !== undefined && String(p).replace(/^\s+|\s+$/g, "") !== "" && String(p) !== "undefined" && String(p) !== "null") {
                    installPath = String(p).replace(/\\/g, "/");
                    debugLog.push("S1 app.path=" + installPath);
                } else {
                    debugLog.push("S1 app.path=" + String(p) + " (rejected)");
                }
            } catch (e1) { debugLog.push("S1 error: " + e1.toString()); }
        }

        // Strategy 2: Folder.startup
        if (!installPath) {
            try {
                var startupFolder = Folder.startup;
                if (startupFolder && startupFolder.fsName) {
                    var raw = String(startupFolder.fsName).replace(/\\/g, "/");
                    var lower = raw.toLowerCase();
                    debugLog.push("S2 raw startup=" + raw);
                    // Folder.startup 通常是 .../Support Files/Scripts/Startup
                    if (lower.indexOf("/scripts/startup") >= 0) {
                        installPath = raw.substring(0, lower.indexOf("/scripts/startup"));
                        debugLog.push("S2 matched /scripts/startup -> " + installPath);
                    } else if (lower.indexOf("/scripts") >= 0) {
                        installPath = raw.substring(0, lower.indexOf("/scripts"));
                        debugLog.push("S2 matched /scripts -> " + installPath);
                    } else if (lower.indexOf("support files") >= 0) {
                        // startup 路径可能已经包含 Support Files
                        installPath = raw.substring(0, lower.indexOf("support files") + "support files".length);
                        debugLog.push("S2 matched support files directly -> " + installPath);
                    } else {
                        debugLog.push("S2 path structure unknown: " + raw);
                    }
                } else {
                    debugLog.push("S2 Folder.startup unavailable");
                }
            } catch (e2) { debugLog.push("S2 error: " + e2.toString()); }
        }

        // Strategy 3: app.version + 标准路径
        if (!installPath) {
            try {
                var version = String(app.version || "").replace(/^\s+|\s+$/g, "");
                var candidates = [];
                if (version) {
                    var isWin = String($.os || "").toLowerCase().indexOf("windows") >= 0;
                    if (isWin) {
                        candidates.push("C:/Program Files/Adobe/Adobe After Effects " + version + "/Support Files");
                        candidates.push("C:/Program Files/Adobe/Adobe After Effects " + version);
                        candidates.push("C:/Program Files/Adobe/Adobe After Effects/Support Files");
                    } else {
                        candidates.push("/Applications/Adobe After Effects " + version);
                        candidates.push("/Applications/Adobe After Effects " + version + "/Scripts");
                    }
                }
                debugLog.push("S3 version=" + version + ", isWin=" + isWin + ", candidates=" + candidates.join("|"));
                for (var ci = 0; ci < candidates.length; ci++) {
                    var f = new Folder(candidates[ci]);
                    if (f.exists) { installPath = candidates[ci]; debugLog.push("S3 hit: " + candidates[ci]); break; }
                }
                if (!installPath) debugLog.push("S3 no candidate exists");
            } catch (e3) { debugLog.push("S3 error: " + e3.toString()); }
        }

        // Strategy 4: 扫描 C:/Program Files/Adobe
        if (!installPath) {
            try {
                var adobeDir = new Folder("C:/Program Files/Adobe");
                if (adobeDir.exists) {
                    var subs = adobeDir.getFiles();
                    for (var si = 0; si < subs.length; si++) {
                        var sub = subs[si];
                        if (sub instanceof Folder) {
                            var subName = String(sub.displayName || sub.name || "");
                            if (subName.toLowerCase().indexOf("after effects") >= 0) {
                                var supportSub = new Folder(sub.fsName + "/Support Files");
                                if (supportSub.exists) {
                                    installPath = String(supportSub.fsName).replace(/\\/g, "/");
                                    debugLog.push("S4 hit support: " + installPath);
                                    break;
                                }
                                installPath = String(sub.fsName).replace(/\\/g, "/");
                                debugLog.push("S4 hit root: " + installPath);
                                break;
                            }
                        }
                    }
                }
                if (!installPath) debugLog.push("S4 no AE folder found");
            } catch (e4) { debugLog.push("S4 error: " + e4.toString()); }
        }

        if (!installPath) {
            return { status: "error", message: "Cannot determine AE install path.", debug: debugLog };
        }

        var hasSupport = installPath.toLowerCase().indexOf("support files") >= 0;
        var supportPath = hasSupport ? installPath : (installPath + "/Support Files");
        if (info === "all") {
            return {
                status: "success",
                root: installPath,
                supportBase: supportPath,
                presets: supportPath + "/Presets",
                scripts: supportPath + "/Scripts",
                plugins: supportPath + "/Plug-ins",
                debug: debugLog
            };
        }
        var resultPath;
        if (info === "presets") resultPath = supportPath + "/Presets";
        else if (info === "scripts") resultPath = supportPath + "/Scripts";
        else if (info === "plug" || info === "plugins") resultPath = supportPath + "/Plug-ins";
        else resultPath = installPath;
        var folder = new Folder(resultPath);
        return { status: "success", path: resultPath, exists: folder.exists, type: info, debug: debugLog };
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}


// 批抓截止时刻（绝对毫秒）。>0 = 当前处于 _getPreviewFrames 的批抓循环内，getPreviewFrame
// 的三段等待预算取「12s 默认」与「本截止」的较早者；单帧调用（工具单时间点/库函数直调）
// 恒为 0，行为与本变量引入前一致。ExtendScript 单线程且抓帧全同步，故无并发写入。
var _previewFrameDeadlineAt = 0;

function getPreviewFrame(args) {
    try {
        // 多时间点（timesInSeconds）：转发到 _getPreviewFrames。单帧抓取与三段等待只有一份
        // 实现（本函数），批抓逐帧调用本函数，不复制任何等待逻辑。
        if (args && args.timesInSeconds !== undefined) {
            return _getPreviewFrames(args);
        }
        // detectSameName：compName 命中多个同名合成时报错（不静默取首个；
        // 渲染等其它工具的同名取首个行为不变）。
        var comp = getActiveComp(args, { detectSameName: true });
        if (!comp) return { status: "error", message: "No active composition found. Open a composition first." };
        // 不调用 comp.openInViewer()。Adobe 脚本指南对该方法的说明是
        // "moves the Composition panel to front and gives it focus"——抓帧时会把合成面板置前并
        // 抢焦点（LLM 后台调用时表现为 AE 被强制拉到前台）。saveFrameToPng 按 comp 对象直接出帧、
        // 不依赖查看器：host/api/projectAssetApi.jsx 的 PSD→PNG 后台渲染同样不调 openInViewer
        //（该文件 225 行注释「后台渲染无需切换 viewer」）。旧注释「so AE renders it properly」无出处，已撤。
        var time = args.timeInSeconds !== undefined ? Number(args.timeInSeconds) : comp.time;
        // 时间范围校验：单帧路径直接取参并按请求值回填 capturedAt 时，
        // 越界时 saveFrameToPng 出白帧仍报 success（真机：5.5 s 合成请求 12 s →
        // success/capturedAt:12/全白，调用方据此误判）。与批量路径 _getPreviewFrames
        // 同口径：钳制到 [0, duration]，回执同时给 requestedAt 与 timeClamped。
        var _timeRequested = time;
        var _timeClamped = false;
        if (typeof time !== "number" || isNaN(time)) {
            return { status: "error", message: "timeInSeconds 不是有效数字: " + String(args.timeInSeconds) };
        }
        if (time < 0) { time = 0; _timeClamped = true; }
        if (comp.duration > 0 && time > comp.duration) { time = comp.duration; _timeClamped = true; }
        // 抓帧分辨率跟随合成面板的分辨率档位（comp.resolutionFactor）：saveFrameToPng 按该档位出图，
        // 档位非 [1,1] 时 PNG 是合成尺寸的 1/N。本工具不改工程状态，只把档位与合成尺寸回报给调用方；
        // 读不到档位（桩/异常）时只缺席 resolutionFactor/resolutionNote，compWidth/compHeight 恒有。
        var _resFactor = null;
        try {
            var _rf = comp.resolutionFactor;
            if (_rf && _rf.length >= 2) {
                var _rfx = Number(_rf[0]);
                var _rfy = Number(_rf[1]);
                if (isFinite(_rfx) && isFinite(_rfy) && _rfx > 0 && _rfy > 0) _resFactor = [_rfx, _rfy];
            }
        } catch (_rfErr) { _resFactor = null; }
        var fileName = "ae_preview_" + (new Date().getTime()) + ".png";
        // 预览帧写盘目录，两级候选（都必须在数据目录内——缓存/临时产物一律写数据目录，
        // 系统临时目录那边的产物没有任何清扫覆盖，用户清过
        // 之后也不会自愈）：
        //   ① 数据目录 temp/ae-tools（面板侧 bootstrap.js 经**授权帧**的 dataDir 传入，支持用户
        //      自定义数据目录；经 args.__dataDir 传入时伪造它等于可控路径写盘，故随
        //      授权位一并换载体）；
        //   ② 数据目录 temp（面板写清扫报告时会被 AEFS 自动建出，通常存在）。
        // 建不出来时必须**当场报错**：沙箱未授权 file 域时 `Folder.create` 被守卫直接抛错
        //（见本文件 File/Folder 原型补丁段的 else 分支），数据目录被清过（用户删过/新装）时
        // AE 侧建不出目录——而把**不存在的目录**交给 saveFrameToPng 会让 **AE 自己弹模态警告**
        // 并阻塞主线程（ExtendScript 跑在 AE 主线程上）→ 工具调用 30s 超时、结果被丢弃，
        // 用户只看到乱码弹框。
        // 面板侧 ensurePreviewDir 会预建 ①（正常路径用不到 ②）。
        // 硬编码 APPDATA 路径保留为无帧通道时的兜底（老调用方/直调路径）。
        var _previewDir = "";
        try {
            var _dd = _authFrame.get().dataDir || "";
            if (!_dd) {
                var _appdata = $.getenv("APPDATA");
                if (_appdata) _dd = _appdata + "\\Adobe\\CEP\\extensions\\AS_ExtP";
            }
            if (_dd) {
                var _ddBase = String(_dd).replace(/[\\\/]+$/, "");
                var _cands = [_ddBase + "\\temp\\ae-tools", _ddBase + "\\temp"];
                for (var _ci = 0; _ci < _cands.length && !_previewDir; _ci++) {
                    var _candFolder = new Folder(_cands[_ci]);
                    if (!_candFolder.exists) {
                        try { _candFolder.create(); } catch (_createErr) {}
                        _candFolder = new Folder(_cands[_ci]);   // create 后重取实例再判在不在
                    }
                    if (_candFolder.exists) _previewDir = _cands[_ci];
                }
            }
        } catch (_) {}
        if (!_previewDir) {
            return {
                status: "error",
                message: "预览帧目录不可用：数据目录下的 temp/ae-tools 与 temp 都不存在且建不出来。"
                    + "按约定缓存只写数据目录（不落系统临时目录）；重启面板会自动预建该目录，"
                    + "若仍失败请检查「数据目录」设置指向的路径是否可写。"
            };
        }
        var outputFile = new File(_previewDir + "/" + fileName);
        comp.saveFrameToPng(time, outputFile);
        // 存在等待(15s)+尺寸稳定(5s)+IEND 校验(3s) 三段最坏叠加 ~23s，逼近默认 30s 工具
        // 超时——大合成时面板误报超时但 AE 侧实际成功。三段等待环共享 12s 总预算（_waitDeadline），
        // 超预算走既有失败分支（对齐半截 PNG 不交付语义），总耗时收敛在 ~12.3s 内。
        var _waitDeadline = (new Date()).getTime() + 12000;
        // 批抓（_getPreviewFrames）逐帧收紧：只取更早的截止，绝不放宽——整批总耗时因此
        // 不越批预算；单帧调用该变量为 0，本行预算不变。
        if (_previewFrameDeadlineAt > 0 && _previewFrameDeadlineAt < _waitDeadline) {
            _waitDeadline = _previewFrameDeadlineAt;
        }
        var maxWait = 150;
        var waitCount = 0;
        $.sleep(200);
        // —— 实时长度读取 ——
        // 必须**每轮新建 File 对象**，绝不复用上面交给 saveFrameToPng 的那个：
        // 那个对象的 `length` 在渐进写入期是**陈旧**的（本函数 IEND 段 :3838 的注释已记录过
        // 实测——文件最终 10,833,057 字节而该对象回报 1,476,761，差一个数量级）。
        // ①② 两段若读它 → 恒读到 0 → 空转到 12s 预算耗尽，报 "created empty file
        // (0 bytes)"，**而文件其实早已完整**（实测：报 0 bytes 的那个 PNG 事后为 157417 字节）；
        // 且预算被 ① 吃光后，下面 ②③ 两段（专为渐进写入而设）根本没机会执行。
        // 这也解释了「有时成功、有时失败」的间歇性：取决于陈旧对象恰好何时刷新。
        // 返回值：-1 = 文件不存在；>=0 = 当前字节数。
        var _liveLen = function () {
            var f = new File(outputFile.fsName);
            return f.exists ? f.length : -1;
        };
        var _len = _liveLen();
        // 等待"非空文件出现"，而非仅"文件存在"：AE saveFrameToPng 是渐进写入——先创建
        // 0 字节文件再写像素。只等 exists 会在 0 字节窗口立刻早退，随即被下方
        // length === 0 判成 "file missing"（实测：报 missing 的 PNG 实际已完整落盘），
        // 且预置的「尺寸稳定 + IEND 校验」两段（专为渐进写入而设）永远没机会执行。
        while (_len <= 0 && waitCount < maxWait && (new Date()).getTime() < _waitDeadline) {
            $.sleep(100);
            waitCount++;
            _len = _liveLen();
        }
        if (_len < 0) {
            return { status: "error", message: "saveFrameToPng did not create file: " + outputFile.fsName + " (waited " + (200 + waitCount * 100) + "ms)" };
        }
        if (_len === 0) {
            return { status: "error", message: "saveFrameToPng created empty file (0 bytes): " + outputFile.fsName + " (waited " + (200 + waitCount * 100) + "ms)" };
        }
        var stableCount = 0;
        for (var w = 0; w < 10 && (new Date()).getTime() < _waitDeadline; w++) {
            $.sleep(300);
            var lenBefore = _liveLen();       // 同上：必须新建对象，勿用 outputFile
            $.sleep(200);
            var lenAfter = _liveLen();
            if (lenBefore === lenAfter && lenBefore > 0) {
                stableCount++;
                if (stableCount >= 2) break;
            } else {
                stableCount = 0;
            }
        }
        // PNG IEND 完整性校验：确认文件末尾有 IEND chunk，防文件头写完但像素数据还在写入。
        // 实测结论：`saveFrameToPng` **在文件写完之前就返回**——1920×1080 的 4.5MB
        // PNG 用逐帧轮询实测耗时约 3.5s（1.35MB@2.1s → 2.63MB@2.6s → 4.01MB@3.1s → 4.56MB@3.6s），
        // 而固定的迭代上限（10 次 × 300ms = 3s）正好在写完前一点点结束 → 大文件恒误报
        // "PNG IEND integrity check failed"，而落盘文件其实是完整的（AI 侧会白丢一次视觉核查）。
        // 现改为**只受总预算约束**（12s 减去前面已用），预算内一直轮询到 IEND 出现为止。
        // 总预算不变（意图保留）：最坏 12s + 尾随 sleep(300ms) ≈ 12.3s << 30s 工具超时。
        var iendOk = false;
        var iendStartMs = (new Date()).getTime();   // 失败分支报表实测耗时（环按预算驱动）
        var iendDiag = "";                          // 最后一次尝试的现场（失败分支回报，供定位）
        // 校验成功时读到的**真实**长度：`outputFile.length`（那个交给 saveFrameToPng 的对象）
        // 在渐进写入期间是陈旧的——实测 8000×5000 合成：文件最终 10,833,057 字节，而
        // outputFile.length 回报 1,476,761（写入中途的值），二者差一个数量级。
        // 故 fileSize 一律用 IEND 校验那一次「新对象」读到的长度（那个是实时的）。
        var verifiedSize = 0;
        for (var vi = 0; (new Date()).getTime() < _waitDeadline; vi++) {
            // 读尾必须用**全新的 File 对象**，不复用交给 saveFrameToPng 的那个（实测结论）：
            //   ① `saveFrameToPng` **立即返回**（实测 0ms），PNG 由 AE 后台渐进写入——4.56MB 的
            //      1920×1080 帧实测 303ms/590KB → 612ms/1.33MB → 915ms/2.17MB → 1220ms/3.10MB
            //      → 1525ms/3.99MB → 1830ms/4.56MB(IEND)，写完前尾部自然不是 IEND（属正常轮询）。
            //   ② 交给 AE 写入的那个 File 对象**此后打不开**：实测 `open("r","BINARY")` 返回 false
            //      （不抛异常）；而同一路径**新建的** File 对象在当前轮就能打开并读到增长中的长度。
            //   ③ 复用同一对象且**不检查 open 返回值** → 首次 false 之后一直 false，
            //      seek/read 作用于未打开对象 → 读到空串 → 恒判"无 IEND" → 静默空转到预算耗尽
            //      （实测报 10864ms 而文件早已完整）→ 大文件恒误报、小文件偶发成功。
            // 同时把 open=false / 长度 / 读到的十二字节写入 iendDiag，让下一次失败能自证机制。
            var chk = new File(outputFile.fsName);
            var chkOpen = false;
            try { chkOpen = chk.open("r", "BINARY"); } catch (_) { chkOpen = false; }
            if (chkOpen) {
                try {
                    // 读尾**只取最后 8 字节、且只校验前 4 个字符**。
                    // 根因（由实测报文自证）：
                    //   ExtendScript 即便以 "BINARY" 打开，read() **仍会做编码转换**——PNG 的
                    //   IEND chunk CRC 是固定值 `AE 42 60 82`，首字节 0xAE ≥ 0x80 会被当作多字节
                    //   序列的首字节吞掉，于是 read(12) 实得 **11 字符**，而判据是
                    //   `tailLen === 12` → 恒 false → **该校验在中文 Windows 上 100% 必然失败**
                    // （不是间歇；的 BINARY 那味药没治住，只是把症状换了形态）。
                    //   实测现场（用户报回）：open=1 len=8130 tail=0000000049454e4474f860
                    //     —— 前 8 字节 00 00 00 00 + "IEND" 解码完全正确，其后的 CRC 只剩 3 字节。
                    // 现法：IEND chunk 的 length 字段恒为 0，故从 len-8 读 8 字节时 "IEND" 必落在
                    //   头 4 个字符上，**完全不碰 CRC 的高位字节**；判据也只比前 4 字符，不要求长度。
                    var chkLen = chk.length;
                    var seekTo = chkLen - 8;
                    if (seekTo < 0) seekTo = 0;
                    chk.seek(seekTo);
                    var tail = chk.read(8);
                    var tailLen = tail ? tail.length : 0;
                    var iendMarker = (tailLen >= 4) ? tail.substring(0, 4) : "";
                    var hex = "";
                    for (var bi = 0; bi < tailLen; bi++) {
                        var cc = tail.charCodeAt(bi);
                        hex += (cc < 16 ? "0" : "") + cc.toString(16);
                    }
                    iendDiag = "open=1 len=" + chkLen + " tail=" + (hex || "(empty)");
                    if (iendMarker === "IEND") { iendOk = true; verifiedSize = chkLen; }
                } finally {
                    // 异常时也要关闭句柄，否则下轮 open 可能因占用失败导致 iendOk 误判
                    try { chk.close(); } catch (_) {}
                }
            } else {
                iendDiag = "open=0（文件被占用或句柄未释放）";
            }
            if (iendOk) break;
            $.sleep(300);
        }
        // IEND 校验失败说明 PNG 仍不完整（渐进写入超窗），半截图不能当成功交付——
        // 返回 error 阻断半截 PNG 进入视觉链路（对齐 projectAssetApi._waitPngStable 的失败分支语义）。
        // 报表耗时用实测毫秒（环按预算驱动，`vi × 300` 不等于耗时）。
        if (!iendOk) {
            return { status: "error", message: "PNG IEND integrity check failed (file may be incomplete): " + outputFile.fsName + " (waited " + (200 + waitCount * 100) + "ms + " + ((new Date()).getTime() - iendStartMs) + "ms IEND checks; last: " + iendDiag + ")" };
        }
        var _frameOut = {
            status: "success",
            success: true,
            // 抓帧身份——回执直接给解析出的合成 id 与名字，调用方不必再按
            // compName 猜目标（同名合成报错时本字段不出现，见 getActiveComp 的 detectSameName）。
            // typeof 守卫：本函数被部分单测按函数段切出来跑（段外 helper 不在），真实模块里
            // _readItemId 恒为函数；守卫只让切片环境回 0，不影响真机。
            compositionId: (typeof _readItemId === "function") ? _readItemId(comp) : 0,
            compName: String(comp.name || ""),
            filePath: String(outputFile.fsName),
            fileName: fileName,
            width: comp.width,
            height: comp.height,
            // 合成尺寸另给一份：width/height 会被面板按 PNG 实际像素校正（降采样档位下两者不同），
            // 调用方据此判断本次抓帧是否被降采样。
            compWidth: comp.width,
            compHeight: comp.height,
            capturedAt: time,
            // fileSize 用校验通过那一次读到的真实长度（outputFile.length 在渐进写入期是陈旧的，
            // 实测 10,833,057 vs 1,476,761）；无校验值时回退旧口径以保证字段恒有值。
            fileSize: verifiedSize || outputFile.length,
            iendVerified: iendOk,
            // 实际落盘目录（诊断用：缓存一律在数据目录内）
            previewDir: String(_previewDir)
        };
        // 越界钳制时如实标注（requestedAt 是调用方请求值，capturedAt 是真实取帧时刻）
        if (_timeClamped) {
            _frameOut.timeClamped = true;
            _frameOut.requestedAt = _timeRequested;
        }
        // 档位非完整时把「图为什么小、怎么拿到清晰的图」一并写进回执：抓帧工具本身不改工程状态，
        // 改档位由调用方决定（同一次脚本内改档位不会立即生效，须另起一次调用抓帧）。修法按**回执里的
        // compositionId** 定位（抓帧目标可以不是活动合成）；当前视图没有 executeExtendScript 时
        //（如导演 lane）给不依赖该工具的兜底，否则指示的修法在那里不可执行。
        if (_resFactor) {
            _frameOut.resolutionFactor = _resFactor;
            if (_resFactor[0] !== 1 || _resFactor[1] !== 1) {
                var _frameId = (_frameOut.compositionId > 0) ? _frameOut.compositionId : 0;
                // 按 Item.id 定位必须用 itemByID：Project.item() 收的是项目项索引，拿 id 当索引会
                // 改到别的合成或直接抛 Invalid index。
                var _frameTarget = _frameId
                    ? ("app.project.itemByID(" + _frameId + ").resolutionFactor")
                    : "app.project.activeItem.resolutionFactor";
                _frameOut.resolutionNote = "抓帧分辨率跟随合成面板的分辨率档位：comp.resolutionFactor=["
                    + _resFactor[0] + "," + _resFactor[1] + "]，整帧 PNG（单帧 filePath 或 fullFramePath、多帧 frames[]）实际像素约为 "
                    + Math.round(comp.width / _resFactor[0]) + "×" + Math.round(comp.height / _resFactor[1])
                    + "（合成 " + comp.width + "×" + comp.height + "）。需要清晰细节时把该合成档位设成 [1,1]："
                    + "有 executeExtendScript 时写 " + _frameTarget + " = [1,1]；没有就请用户在合成面板把分辨率切到「完整」。"
                    + "改档位后另起一次调用抓帧（同一次脚本内改档位不生效），抓完还原成 ["
                    + _resFactor[0] + "," + _resFactor[1] + "]。";
            }
        }
        return _frameOut;
    } catch (e) {
        var _frameErr = { status: "error", message: e.toString() };
        // 同名合成歧义由 getActiveComp 抛出，命中列表随回执外带（机器可读）；
        // 其它错误无 matchedCompositionIds，字段不出现（协议不变）。
        if (e && e.matchedCompositionIds && e.matchedCompositionIds.length > 1) {
            _frameErr.matchedCompositionIds = e.matchedCompositionIds;
            if (e.compName) _frameErr.compName = e.compName;
        }
        return _frameErr;
    }
}

// analyzeImage：参数化图片分析工具的宿主入口——只确定「分析哪张图」：
//   · 给了 filePath → 文件模式：校验路径与存在性，返回文件元数据，attachImage:false
//     （面板侧只回指标、不回图，视觉上下文不被占用）；
//   · 未给 filePath → 抓帧模式：复用 getPreviewFrame（合成定位 + PNG 落盘 + IEND 校验
//     单点，不复制等待链），回执带 attachImage:true，由面板 vision hook 把帧图注入上下文。
//     合成定位与单帧时间参数与 getPreviewFrame 同口径：compName / compositionId /
//     compositionIndex / timeInSeconds；给 timesInSeconds（2–6 个）时走 _getPreviewFrames
//     多时间点抓帧，面板侧逐帧分析并由 previewSheet 合成联系表回送。
// 像素解码与指标统计在面板侧（client/modules/ae-tools/imageAnalysis.js）：AE 没有 canvas，
// 且 AE 23.5 没有 Layer.sampleImage，像素只能经 PNG 到面板侧读。
// filePath 的读取安全由面板 AEFS -> bridge /api/read-image 的路径闸把守；本函数只做
// 绝对路径/扩展名/存在性预检，让模型尽早拿到可解释的失败原因。
function analyzeImage(args) {
    try {
        var filePath = (args && typeof args.filePath === "string") ? args.filePath.replace(/^\s+|\s+$/g, "") : "";
        if (filePath) {
            // 注意：ExtendScript 的**正则字面量**里 `/` 必须转义（即使在字符类里也不认「类内免转义」）：
            // 字符类里写未转义的 `/`，解析器会把转义反斜杠之后的 `/` 当作字面量结束符 ⇒ 整份
            // aeTools.jsx 在 $.evalFile 时抛「无法执行脚本。应为: )」，所有 AE 工具加载失败。
            // 正确写法是反斜杠与斜杠都转义（与 host.jsx / projectAssetApi.jsx 的既有写法一致）。

            if (!/^(?:[a-zA-Z]:[\\\/]|\\\\)/.test(filePath)) {
                return { status: "error", message: "filePath 需为绝对路径（如 D:\\out\\frame.png）: " + filePath };
            }
            // PNG / JPEG；也接受 AE 渲染队列的序列产物名（X.png00000——真实后缀是
            // 「扩展名+纯数字」，与 listFolderFiles/read_image 的序列口径一致）。
            if (!/\.(png|jpe?g)\d*$/i.test(filePath)) {
                return { status: "error", message: "filePath 只支持 PNG/JPEG 图片（含序列产物 X.png00000）: " + filePath };
            }
            var f = new File(filePath);
            if (!f.exists) {
                return { status: "error", message: "图片文件不存在: " + filePath };
            }
            return {
                status: "success",
                success: true,
                mode: "file",
                filePath: String(f.fsName),
                fileName: String(f.name),
                fileSize: f.length,
                attachImage: false,
                note: "文件模式：只返回分析指标，不把图片送回上下文；需要看图时用 read_image 或 getPreviewFrame。"
            };
        }
        // 抓帧模式：合成定位参数与 getPreviewFrame 同口径（id/index 优先于活动合成）。
        var capArgs = {};
        if (args && args.compName !== undefined && args.compName !== null) capArgs.compName = args.compName;
        if (args && args.compositionId !== undefined && args.compositionId !== null) capArgs.compositionId = args.compositionId;
        if (args && args.compositionIndex !== undefined && args.compositionIndex !== null) capArgs.compositionIndex = args.compositionIndex;
        if (args && args.compIndex !== undefined && args.compIndex !== null) capArgs.compIndex = args.compIndex;
        // 多时间点：与 getPreviewFrame 同形（2–6 个时间点，批预算按帧数伸缩）；每帧各自分析，
        // 联系表由面板 previewSheet 合成（顶层 filePath 指向联系表，视觉上下文注入该表）。
        if (args && args.timesInSeconds !== undefined) {
            capArgs.timesInSeconds = args.timesInSeconds;
            // 不收紧批预算：逐帧分析 + 合成联系表发生在 AE 回执之后（面板 createHandler 的
            // postProcess 在 clearTimeout 之后执行），不占执行超时；收紧只会让多帧抓不全。
            var multi = _getPreviewFrames(capArgs);
            if (!multi || multi.status !== "success") {
                return multi || { status: "error", message: "多时间点抓帧失败（_getPreviewFrames 未返回结果）" };
            }
            multi.mode = "captureMulti";
            multi.attachImage = true;
            multi.note = "多时间点模式：每帧各自分析（analysis.frames[]）；图像上下文注入面板合成的带时间标签联系表。";
            return multi;
        }
        if (args && args.timeInSeconds !== undefined && args.timeInSeconds !== null) capArgs.timeInSeconds = args.timeInSeconds;
        var cap = getPreviewFrame(capArgs);
        if (!cap || cap.status !== "success") {
            return cap || { status: "error", message: "抓帧失败（getPreviewFrame 未返回结果）" };
        }
        cap.mode = "capture";
        cap.attachImage = true;
        cap.note = "抓帧模式：图片随指标一并注入视觉上下文；模型无视觉能力时只使用指标。";
        return cap;
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

// 多时间点抓帧（getPreviewFrame 的 timesInSeconds 分支）——本函数不做合成，只逐时间点抓
// PNG 并回报列表；多帧合成一张联系表在面板侧做（client/modules/ae-tools/previewSheet.js，
// 纯 JS 侧才有 canvas）。
// 设计取舍：
//   - 等待逻辑单点：逐帧调用 getPreviewFrame（含非空→尺寸稳定→IEND 三段校验），本函数只管
//     时间点归一、批预算与 partial 语义，不复制任何等待代码。
//   - 帧数上限 6：每帧实测 2–4s（1080p 4.5MB PNG 实测约 3.5s；慢环境 8–9s），抓完还要在
//     面板侧读 N 张 PNG 并合成联系表；面板执行超时按帧数抬升（bootstrap.previewBatchTimeoutMs，
//     上限 120s），外接 relay 的 100s 等待由 ext_progress 心跳续期。
//   - 预算耗尽或单帧失败都不静默丢帧：回报已抓到的 frames 与 timesMissing，补齐再调一次即可。
function _getPreviewFrames(args) {
    var MAX_TIMES = 6;
    // 批预算按帧数伸缩：帧数 × 单帧等待上限 + 起帧余量，上限 75s（6 帧 6×12s+3s）；
    // 从 2 帧起算（27s）。FRAME_WAIT_BUDGET_MS 与 getPreviewFrame 的 _waitDeadline（同为 12s）
    // 是镜像点：单帧抓取的实际等待上限改了就同步改这里，否则最后一帧的预算会与单帧能力脱节。
    // 面板执行超时注册面（bootstrap.js previewBatchTimeoutMs）必须大于本预算——两处数字
    // 须同步改（任一上限变更后重跑用例核对）。
    var FRAME_WAIT_BUDGET_MS = 12000;
    var MAX_BATCH_BUDGET_MS = 75000;   // 6 帧上限：6×12s = 72s + 3s 起帧余量
    var FRAME_MIN_MS = 2500;           // 剩余预算低于此值不再起新帧（起了大概率抓不完）
    var REQ = "timesInSeconds 需为 1–6 个有限秒数（数组，如 [0, 0.5, 1.0]）";
    try {
        // 与单帧路径同判据——compName 命中多个同名合成时报歧义（否则逐帧
        // 抓帧会静默抓第一个同名合成，且每帧失败被折叠成「全部时间点抓帧失败」）。
        var comp = getActiveComp(args, { detectSameName: true });
        if (!comp) return { status: "error", message: "No active composition found. Open a composition first." };
        // 合成定位参数基座：与单帧路径同口径转发（compName / compositionId /
        // compositionIndex），多时间点抓帧因此也能指定合成，而不是只能抓活动合成。
        var _capBase = { compName: args.compName };
        // null = 未传（所有可选 id/index 参数同一口径）
        if (args.compositionId !== undefined && args.compositionId !== null) _capBase.compositionId = args.compositionId;
        if (args.compositionIndex !== undefined && args.compositionIndex !== null) _capBase.compositionIndex = args.compositionIndex;
        if (args.compIndex !== undefined && args.compIndex !== null) _capBase.compIndex = args.compIndex;
        var raw = args.timesInSeconds;
        // 形态：必须是数组。`typeof raw.length !== "number"` 对
        // 字符串恒为假，"1.5" 会被逐字符拆成 1 与 5 两个时间点（比报错更难发现）。
        // 判定与 _isArrayValue 同口径，但内联写：本函数被单测按函数体切出来跑（无模块级辅助）。
        if (!raw || Object.prototype.toString.call(raw) !== "[object Array]" || raw.length === 0) {
            return { status: "error", message: REQ };
        }
        if (raw.length > MAX_TIMES) {
            return { status: "error", message: "最多 " + MAX_TIMES + " 个时间点（收到 " + raw.length + " 个）：拆成两次调用，或减少采样点。" };
        }
        var times = [];
        var clamped = false;
        for (var i = 0; i < raw.length; i++) {
            var t = Number(raw[i]);
            if (isNaN(t) || !isFinite(t)) {
                return { status: "error", message: "timesInSeconds 第 " + (i + 1) + " 项不是有限数：" + raw[i] };
            }
            if (t < 0) { t = 0; clamped = true; }
            if (comp.duration > 0 && t > comp.duration) { t = comp.duration; clamped = true; }
            times.push(t);
        }
        // 单点：与单帧路径同形（多一个 times 字段），不走批预算
        if (times.length < 2) {
            var _oneArgs = {};
            for (var _ok in _capBase) {
                if (_capBase.hasOwnProperty(_ok)) _oneArgs[_ok] = _capBase[_ok];
            }
            _oneArgs.timeInSeconds = times[0];
            var one = getPreviewFrame(_oneArgs);
            if (one && one.status === "success") {
                one.times = [times[0]];
                if (clamped) one.timeClamped = true;
            }
            return one;
        }
        // 批预算按实际帧数伸缩（单点分支已提前返回，此处至少 2 帧，最小 27s）。
        // __batchBudgetMs 只允许缩短（直调方的收紧能力保留），放大一律忽略——放大后的等待上限
        // 超出面板执行超时，反而会把整批结果一起丢掉。
        var _budgetMs = Math.min(MAX_BATCH_BUDGET_MS,
            times.length * FRAME_WAIT_BUDGET_MS + 3000);
        if (args && typeof args.__batchBudgetMs === "number" && isFinite(args.__batchBudgetMs)
            && args.__batchBudgetMs >= 4000 && args.__batchBudgetMs < _budgetMs) {
            _budgetMs = Math.floor(args.__batchBudgetMs);
        }
        var deadline = (new Date()).getTime() + _budgetMs;
        var frames = [];
        var captured = [];
        var missing = [];
        var failures = [];
        var previewDir = "";
        // 分辨率档位元数据（与单帧回执同形）：整批同一合成，取首帧即可。
        var _resMeta = null;
        // 抓帧身份取自**单帧成功回执**（getPreviewFrame 已带 compositionId/
        // compName）——批抓不重复解析合成，切片单测的 getPreviewFrame 桩没有这两个字段时
        // 保持 0/空串，不编造。
        var _resCompId = 0;
        var _resCompName = "";
        for (var k = 0; k < times.length; k++) {
            var now = (new Date()).getTime();
            if (deadline - now < FRAME_MIN_MS) { missing.push(times[k]); continue; }
            _previewFrameDeadlineAt = Math.min(now + FRAME_WAIT_BUDGET_MS, deadline);
            var r;
            try {
                var _frameArgs = {};
                for (var _fk in _capBase) {
                    if (_capBase.hasOwnProperty(_fk)) _frameArgs[_fk] = _capBase[_fk];
                }
                _frameArgs.timeInSeconds = times[k];
                r = getPreviewFrame(_frameArgs);
            } finally {
                _previewFrameDeadlineAt = 0;
            }
            if (!r || r.status !== "success" || !r.filePath) {
                // 单帧失败多为该时间点的渲染问题（如表达式报错帧），不阻断其余时间点
                failures.push(times[k] + "s: " + ((r && r.message) || "未知错误"));
                missing.push(times[k]);
                continue;
            }
            if (_resCompId <= 0 && typeof r.compositionId === "number" && r.compositionId > 0) {
                _resCompId = r.compositionId;
                _resCompName = String(r.compName || "");
            }
            if (r.previewDir) previewDir = r.previewDir;
            if (!_resMeta && r.resolutionFactor) {
                _resMeta = {
                    factor: r.resolutionFactor,
                    compWidth: r.compWidth,
                    compHeight: r.compHeight,
                    note: r.resolutionNote
                };
            }
            frames.push({
                time: times[k],
                filePath: r.filePath,
                fileName: r.fileName,
                fileSize: r.fileSize,
                width: r.width,
                height: r.height,
                iendVerified: r.iendVerified
            });
            captured.push(times[k]);
        }
        if (frames.length === 0) {
            return {
                status: "error",
                message: "全部时间点抓帧失败" + (failures.length ? "（" + failures.join("；") + "）" : "（批预算不足）"),
                timesMissing: missing
            };
        }
        var out = {
            status: "success",
            success: true,
            // 抓帧身份（与单帧路径同字段）——回执给出解析出的合成 id 与名字。
            compositionId: _resCompId,
            compName: _resCompName,
            frameCount: frames.length,
            times: captured,
            frames: frames,
            // 顶层字段与单帧同形：面板 vision hook 与外接内联链按 filePath 取图；多帧由面板
            // 合成联系表后改写为表路径（合成失败时回退到这里指向的第一帧）。
            filePath: frames[0].filePath,
            fileName: frames[0].fileName,
            width: frames[0].width,
            height: frames[0].height,
            fileSize: frames[0].fileSize,
            capturedAt: frames[0].time,
            iendVerified: true,
            previewDir: previewDir
        };
        // 档位元数据与单帧回执同口径（顶层 width/height 会被面板改指联系表尺寸；帧的实际像素看
        // frames[].width/height，面板按 IHDR 逐帧校正）。
        if (_resMeta) {
            out.resolutionFactor = _resMeta.factor;
            if (_resMeta.compWidth) out.compWidth = _resMeta.compWidth;
            if (_resMeta.compHeight) out.compHeight = _resMeta.compHeight;
            if (_resMeta.note) out.resolutionNote = _resMeta.note;
        }
        if (clamped) out.timeClamped = true;
        if (missing.length) {
            var missingText = [];
            for (var mi = 0; mi < missing.length; mi++) missingText.push(missing[mi] + "s");
            out.partial = true;
            out.timesMissing = missing;
            out.message = "已抓 " + frames.length + " 帧（批预算 " + (_budgetMs / 1000) + "s 内）；未抓时间点：" + missingText.join("、")
                + "。补齐这几个时间点再调一次即可。";
        }
        return out;
    } catch (e) {
        var _framesErr = { status: "error", message: e.toString() };
        // 同名合成歧义外带命中列表（与单帧路径同口径；其它错误无该字段）。
        if (e && e.matchedCompositionIds && e.matchedCompositionIds.length > 1) {
            _framesErr.matchedCompositionIds = e.matchedCompositionIds;
            if (e.compName) _framesErr.compName = e.compName;
        }
        return _framesErr;
    }
}

function openInViewer(args) {
    try {
        var comp = getActiveComp(args);
        if (!comp) return { status: "error", message: "No active composition found." };
        var viewer = comp.openInViewer();
        if (viewer === null) {
            return { status: "error", message: "Failed to open composition in viewer: " + comp.name };
        }
        return {
            status: "success",
            compName: comp.name,
            width: comp.width,
            height: comp.height,
            duration: comp.duration,
            frameRate: comp.frameRate,
            message: "Composition opened in viewer"
        };
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}



// ============================================================
// 图层控制工具 (10个)
// ============================================================





// 读取图层上任意属性的详细信息：当前值、关键帧（含缓动）、表达式、插值类型。
// 支持直接属性（Position/Scale 等）、效果内属性（需 effectIndex 或 effectName 定位）、
// 蒙版属性（需 maskIndex 或 maskName 定位）。补齐 getLayerInfo 仅覆盖 transform 5 属性的缺口。

// 守卫会把 `File.prototype` 的 `rename`/`remove` 换成 throw 版（未授权 file 域时），而**面板模板
// 在调核之前就装了守卫**（`__aeSGOn()`，见 bootstrap.js 拼装脚本）——核内那一次备份因此被挡死
// （真机 E2E：直调 helper 成功 backed=1，走工具通道恒 backed=0）。本 helper 属
// 框架代码、只在渲染触发时动**队列输出路径**，须在守卫窗口内照常工作——故在**模块加载时**
// （无守卫）捕获原型真方法，用 `.call` 直调。两个名字已登记 `_INTERNAL_NAMES`，authored 代码
// 按名引用会被 AST 门拒，拿不到这两个引用。
var _realFileRename = (typeof File !== "undefined" && File && File.prototype) ? File.prototype.rename : null;
var _realFileRemove = (typeof File !== "undefined" && File && File.prototype) ? File.prototype.remove : null;
// 同款捕获（参数式渲染工具 renderComp 用）：它在核的 shadow 窗口内运行，
// 窗口里裸 `File` 是遮蔽值/门构造器（file 域关时构造即抛），须用加载时的真构造器。
var _realFileCtor = (typeof File !== "undefined") ? File : null;
// 同款捕获：序列渲染产物发现要枚举输出目录。renderComp 在核 shadow 窗口内
// 运行，窗口里 `Folder` 也是遮蔽值/门构造器，故同样用加载时的真构造器。
var _realFolderCtor = (typeof Folder !== "undefined") ? Folder : null;

// ── 渲染产物发现（序列输出模块的帧号命名）──
// 现象（AE 2023 真机实测）：渲染队列 + PNG 序列输出模块会在整条路径末尾追加帧号——
// 请求 `X.png` 实际落盘 `X.png00000`（`om.file.fsName` 仍是 `X.png`）。旧 renderComp 只探测
// 字面路径，于是成功渲染却回执 `productExists:false`，调用方以为没落盘。
// 本组 helper 只做「按请求路径推出同目录同基名候选」，不改变任何写盘路径语义：
//   · 形态 A：<请求名>+纯数字（X.png00000，本机 AE 的 PNG 序列形态）
//   · 形态 B：<基名>+纯数字+<扩展名>（X00000.png，部分输出模块的形态）
// 仅图片扩展名启用形态 B；纯数字后缀规则对其它扩展名也启用形态 A（H.264 等单文件产物
// 通常精确同名，不命中任何形态）。
// modified 用于「这次渲染刚写的」新鲜度过滤（AE File.modified 为 Date；取不到即不过滤）。
function _findRenderProducts(outputPath, freshAfterMs) {
    var res = [];
    if (!_realFolderCtor || !outputPath) return res;
    var sep = Math.max(outputPath.lastIndexOf("/"), outputPath.lastIndexOf("\\"));
    if (sep <= 0) return res;                    // 盘根路径已被 _isSystemOrRootDir 拒，保守退出
    var dir = outputPath.substring(0, sep);
    var reqName = outputPath.substring(sep + 1);
    if (!dir || !reqName) return res;
    var dot = reqName.lastIndexOf(".");
    var base = (dot > 0) ? reqName.substring(0, dot) : reqName;
    if (!base) return res;
    var extLower = (dot > 0) ? reqName.substring(dot).toLowerCase() : "";
    var folder = null;
    try { folder = new _realFolderCtor(dir); } catch (_e0) { return res; }
    if (!folder || !folder.exists) return res;
    var list = [];
    try { list = folder.getFiles() || []; } catch (_e1) { return res; }
    var baseLower = base.toLowerCase();
    var imgExt = (extLower === ".png" || extLower === ".jpg" || extLower === ".jpeg");
    var startMs = (typeof freshAfterMs === "number" && freshAfterMs > 0) ? freshAfterMs : 0;
    for (var i = 0; i < list.length; i++) {
        var f = list[i];
        if (!f) continue;
        var nm = "";
        try { nm = String(f.displayName || f.name || ""); } catch (_e2) { nm = ""; }
        if (!nm) continue;
        var nmLower = nm.toLowerCase();
        var hit = false;
        if (extLower) {
            if (nmLower.indexOf(baseLower + extLower) === 0) {
                hit = /^\d+$/.test(nmLower.substring((baseLower + extLower).length));
            }
            if (!hit && imgExt && nmLower.indexOf(baseLower) === 0
                && nmLower.length > (baseLower.length + extLower.length)
                && nmLower.substring(nmLower.length - extLower.length) === extLower) {
                var mid = nmLower.substring(baseLower.length, nmLower.length - extLower.length);
                hit = /^\d+$/.test(mid);
            }
        } else if (nmLower.indexOf(baseLower) === 0) {
            hit = /^\d+$/.test(nmLower.substring(baseLower.length));
        }
        if (!hit) continue;
        var fp = "";
        try { fp = String(f.fsName || ""); } catch (_e3) { fp = ""; }
        if (!fp) continue;
        var size = -1;
        try { size = f.length; } catch (_e4) { size = -1; }
        if (typeof size !== "number" || size < 0) continue;    // File.length = -1 表示目录
        var mt = 0;
        try { if (f.modified) mt = f.modified.getTime() || 0; } catch (_e5) { mt = 0; }
        if (startMs > 0 && mt > 0 && mt < startMs - 5000) continue;   // 5s 容差吸收 FS 时间精度
        res.push({ path: fp, name: nm, size: size, modifiedMs: mt });
    }
    return res;
}

// 守卫窗口内改名/覆盖删除（真 File 原型方法 + 换槽协议，同 _backupRenderOutputs）：
// 目标已存在时先删，再改名；返回值只表示改名是否成立，失败不抛。
function _renameInGuardWindow(from, to) {
    if (!_realFileCtor || !_realFileRename || !_realFileRemove) return false;
    if (!from || !to || from === to) return false;
    var _fp = (typeof File !== "undefined" && File && File.prototype) ? File.prototype : null;
    var _savedRename = _fp ? _fp.rename : null;
    var _savedRemove = _fp ? _fp.remove : null;
    var _swapped = false;
    if (_fp) { _fp.rename = _realFileRename; _fp.remove = _realFileRemove; _swapped = true; }
    var ok = false;
    try {
        var src = new _realFileCtor(from);
        if (src.exists) {
            try {
                var dst = new _realFileCtor(to);
                if (dst.exists) dst.remove();
            } catch (_eDst) { }
            try { src.rename(to); ok = true; } catch (_eRen) { ok = false; }
        }
    } catch (_eAll) { ok = false; }
    finally {
        if (_swapped && _fp) {
            try { _fp.rename = _savedRename; _fp.remove = _savedRemove; } catch (_rb) { }
        }
    }
    return ok;
}

// 渲染前把「同基名的历史序列产物」留一代 `<产物>.prev`（只留一代：先删旧 .prev 再改名）。
// 由 _backupRenderOutputs 在字面路径不存在时调用——序列形态下字面路径恒不存在，
// 直接 skipped 会让 .prev 保护对序列产物失效。返回留下的 .prev 路径数组。
function _backupSequenceProducts(outputPath) {
    var renamed = [];
    if (!outputPath) return renamed;
    var found = [];
    try { found = _findRenderProducts(outputPath, 0); } catch (_e0) { found = []; }
    for (var i = 0; i < found.length; i++) {
        var prevPath = found[i].path + ".prev";
        if (_renameInGuardWindow(found[i].path, prevPath)) renamed.push(prevPath);
    }
    return renamed;
}

// ── 渲染覆盖前把已存在的产物改名留一代（.prev） ──
// 为什么：AE 渲染到已存在产物会弹「所选输出模块将覆盖已存在的文件。要允许此操作，请按
// "确定"。」模态并卡住脚本引擎（真机对照与实测数据见 executeExtendScript 渲染触发处注释）。
// 除对话框抑制外，再加一层「不丢数据」：覆盖前把旧产物改名留一代，固定名
// `<名>.prev<扩展名>`（只留一代——旧 .prev 先删再写）。顺带把「文件已存在」这个条件本身
// 消掉，多数情况下抑制窗口根本用不上。
// **调用时机硬约束**：必须在 shadow/原型补丁**之前**——窗口内 `File.prototype.rename/remove`
// 是守卫的 throw 版（未授权 file 域时），备份会静默失效。两处调用点：executeExtendScript
// 渲染触发处（`_renderTrigger` 求值后、保存原始引用之前）与 bootstrap.js 拼装脚本头部
// （`__aeSGOn()` 之前）。判据与抑制窗口共用 `_renderTrigger`。
// 范围：只动队列里 render=true 的项 × 各自输出模块的 file 路径，且该路径存在、且不是目录；
// 序列产物（file 为 `[#####]` 形态的模式路径）exists=false 自然跳过。任何一步失败只跳过该
// 项——备份尽力而为，绝不影响渲染本体。返回值 `{backed, skipped}` 供回执如实上报。
function _backupRenderOutputs() {
    var backed = 0, skipped = 0, renamed = [];
    // 守卫窗口内原型槽 rename/remove 是 throw 版：**临时换回**加载时捕获的真方法，调用完立刻
    // 换回（同步窗口内无 authored 代码可插队）。**不用 `.call` 直调捕获引用**——真机实测
    // 守卫窗口内 `.call` 宿主方法会抛宿主级错误（「在需要数字、数组或属性的位置
    // 找到类型为"Error"的对象」，绕过 try/catch 的那类）；换槽 + 正常实例调用可行（真机 E2E 验过）。
    var _fp = (typeof File !== "undefined" && File && File.prototype) ? File.prototype : null;
    var _savedRename = _fp ? _fp.rename : null;
    var _savedRemove = _fp ? _fp.remove : null;
    var _swapped = false;
    if (_fp && _realFileRename && _realFileRemove) {
        _fp.rename = _realFileRename; _fp.remove = _realFileRemove; _swapped = true;
    }
    try {
        var rq = app.project.renderQueue;
        var n = rq.numItems;
        for (var i = 1; i <= n; i++) {
            var item = null;
            try { item = rq.item(i); } catch (e0) { continue; }
            // 只有**真会被 render() 处理**的项才备份：`render=true` **且** `status=QUEUED`。
            // 渲染完成后 `status=DONE`（3019）而
            // `render` 仍为 true，此时 render() 什么都不渲——只按 render 判会把产物改名走却
            // 没有新渲染，目标路径反而变空。判据复用 `_rqStatusName`（映射单一来源）。
            var willRender = false;
            try { willRender = !!item.render && (_rqStatusName(item.status) === 'queued'); } catch (e1) { willRender = false; }
            if (!willRender) { continue; }
            var mCount = 1;
            try { mCount = item.numOutputModules || 1; } catch (e2) { mCount = 1; }
            for (var m = 1; m <= mCount; m++) {
                var p = "";
                try { var omFile = item.outputModule(m).file; p = omFile ? String(omFile.fsName) : ""; } catch (e3) { p = ""; }
                if (!p) { skipped++; continue; }
                // AE 23.5 真机实测：`File.exists`/`Folder.exists` **都只表示「路径
                // 存在」**——目录的 `File.exists` 同样为 true，`Folder.exists` 对文件也为 true
                // （按「Folder.exists=目录」判，结果把所有正常产物判成目录、备份永远跳过；
                // 真机 E2E 抓出）。判目录只能用 `File.length`：**目录恒 -1**，文件为字节数。
                var exists = false, len = -1;
                try { var fObj = new File(p); exists = fObj.exists; len = fObj.length; } catch (e4) { exists = false; }
                if (!exists) {
                    // 序列输出模块的产物是 `<请求名>+帧号`（X.png00000），字面路径
                    // 恒不存在——直接 skipped 会让 .prev 保护对序列产物失效。改为按同基名
                    // 发现历史序列产物并逐个留一代 `.prev`（只留一代）。
                    var seqPrev = _backupSequenceProducts(p);
                    if (seqPrev.length > 0) {
                        backed += seqPrev.length;
                        renamed = renamed.concat(seqPrev);
                    } else {
                        skipped++;
                    }
                    continue;
                }
                if (len < 0) { skipped++; continue; }   // 目录：不碰（改名目录 = 危险）
                var dot = p.lastIndexOf(".");
                var sep = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
                var hasExt = (dot > sep + 1);
                var prevPath = (hasExt ? p.substring(0, dot) : p) + ".prev" + (hasExt ? p.substring(dot) : "");
                try {
                    var prev = new File(prevPath);
                    if (prev.exists) { prev.remove(); }   // 只留一代：上一份 .prev 让位
                    new File(p).rename(prevPath);
                    backed++;
                    renamed.push(prevPath);
                } catch (e6) { skipped++; }
            }
        }
    } catch (eAll) { }
    // 换回守卫槽（不还原 = 永久削弱守卫）
    if (_swapped) { try { _fp.rename = _savedRename; _fp.remove = _savedRemove; } catch (_rb) { } }
    return { backed: backed, skipped: skipped, renamed: renamed };
}

// ── 参数式渲染工具宿主实现（renderComp）──
// 为什么：`OutputModule.file` 挂 file 域，域关时外部/agent 通道**指定不了输出位置**（门拒原文：
// 「类型「OutputModule」未收录成员「file」…本次拒绝由「file」能力域未开启引起」）。不放开
// `.file`，改为**参数式入口**——路径在本函数内校验，把关口径与 file 域开时 `new File` 同级。
// 参数：outputPath（必填）/ compName（缺省当前活动合成）/ renderPreset / outputModulePreset
// 行为：重建队列项（同合成旧项先移除——DONE 项的 `render` 不可写，真机实测）→ 按名应用预设 →
//   设输出路径 → 覆盖前留一代 `.prev` → `renderQueue.render()`（阻塞）。
// 安全口径：`_checkPath`（绝对路径；拒 %/控制字符/引号/`.`·`..` 段/DOS 设备名）+ `_isSensitivePath`
//   （凭据类）+ `_isSystemOrRootDir`（系统目录/盘根）。**不限定 SAFE_NAMESPACES**——渲染产物是
//   用户数据，落 `D:\out\…` 是正常需求（与 file 域开时核侧 `_GateFile` 构造器同口径）。
// 与框架层的关系：工具模板层已按渲染触发（判据含 renderComp）套对话框抑制与在途门；但框架的
//   渲染前 `.prev` 备份发生在工具代码**之前**（那时队列项还没配），故本函数设完路径后再调一次
//   `_backupRenderOutputs()`，并把结果写进回执。
function renderComp(args) {
    args = args || {};
    var out = { status: "success", tool: "renderComp" };
    var outputPath = (typeof args.outputPath === "string") ? args.outputPath : "";
    if (!outputPath) { return { status: "error", message: "缺少 outputPath（渲染产物写到哪个文件，绝对路径）" }; }
    if (!_checkPath(outputPath)) { return { status: "error", message: "outputPath 非法（需绝对路径；不得含 %、控制字符、引号、. / .. 路径段或 DOS 设备名）: " + outputPath }; }
    if (_isSensitivePath(outputPath)) { return { status: "error", message: "outputPath 命中敏感路径黑名单（凭据类文件），拒绝: " + outputPath }; }
    if (_isSystemOrRootDir(outputPath)) { return { status: "error", message: "outputPath 位于系统目录/盘根，拒绝: " + outputPath }; }

    // 输出父目录预检：目录不存在时 AE 要到渲染末期才抛本地化错误，且经
    // evalScript 回传是 GBK 乱码（真机：out\ 不存在 → 连续 3 次失败，回执不可读，模型只能换
    // 目录重渲）。此处只读探测存在性——file 域关闭时 File/Folder.exists 读取不受守卫拦截
    // （见本文件 File/Folder 原型补丁的 else 分支；_backupRenderOutputs 同款用法）。
    // 不提供建目录能力：本地文件能力由 file 域统一把关。
    var _outParentDir = (function (p) {
        var s = String(p || "");
        var cut = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
        return cut > 0 ? s.substring(0, cut) : "";
    })(outputPath);
    if (_realFolderCtor && _outParentDir) {
        var _parentExists = false;
        try { _parentExists = !!new _realFolderCtor(_outParentDir).exists; } catch (_ePre) { _parentExists = false; }
        if (!_parentExists) {
            return {
                status: "error",
                message: "输出目录不存在: " + _outParentDir
                    + "。请改到已存在的目录（本工具不创建目录；需要新目录时由用户创建）。"
            };
        }
    }

    // ① 解析合成
    var comp = null;
    try {
        if (args.compName) {
            for (var i = 1; i <= app.project.numItems; i++) {
                var it = app.project.item(i);
                if ((it instanceof CompItem) && it.name === String(args.compName)) { comp = it; break; }
            }
            if (!comp) {
                var names = [];
                for (var j = 1; j <= app.project.numItems; j++) { var c = app.project.item(j); if (c instanceof CompItem) { names.push(c.name); } }
                return { status: "error", message: "找不到合成「" + args.compName + "」。现有合成：" + (names.length ? names.join("、") : "（无）") };
            }
        } else {
            comp = app.project.activeItem;
            if (!comp || !(comp instanceof CompItem)) {
                return { status: "error", message: "未指定 compName，且当前没有选中的合成；请传 compName 或先选中一个合成。" };
            }
        }
    } catch (e0) { return { status: "error", message: "解析合成失败: " + e0 }; }
    out.comp = comp.name;

    // ② 新建队列项（同合成旧项**延后**到预设校验通过后再移除：校验失败时项目零副作用）
    //    先删既有项再校验时——预设名写错/挑不到模板时队列项已丢，"零副作用"
    //    不成立。现在先入队新项、所有校验失败只撤新项，校验通过后才删旧项。
    var q = null, item = null, removed = 0;
    try {
        q = app.project.renderQueue;
        item = q.items.add(comp);
    } catch (e2) { return { status: "error", message: "入队失败: " + e2 }; }
    // 校验失败统一撤掉刚建的新项（旧项尚未动）；成功路径不用它
    function _discardNewItem() {
        try { if (item) { item.remove(); } } catch (_eDiscard) { }
    }
    var om = null;
    try { om = item.outputModule(1); } catch (e3) { _discardNewItem(); return { status: "error", message: "取输出模块失败: " + e3 }; }

    // ③ 预设：按名校验（预设名本地化，不能猜；缺失时报错并列出可用名）
    //    省略 outputModulePreset 且产物扩展名为 .mp4/.m4v 时按扩展名自动挑
    //    兼容模板。真机实测（AE 2023 中文版）：不传输出模块预设会沿用队列项默认模块
    //    （通常「无损」/Lossless），把 .mp4 产物交给它后 q.render() 抛 AE 本地化错误，
    //    且该错误经 evalScript 回传是 GBK→Latin-1 乱码（模型只能换预设重试）。
    //    只在「扩展名与输出模块家族明确不兼容」时干预；显式传参、其他扩展名行为不变。
    function _extOf(p) {
        var s = String(p || "");
        var sep = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
        var dot = s.lastIndexOf(".");
        return (dot > sep + 1 && dot < s.length - 1) ? s.substring(dot + 1).toLowerCase() : "";
    }
    function _omMatchesMp4(name) {
        return /h\.?264|mpeg-?4|mpeg4|mp4/i.test(String(name || ""));
    }
    function _pickMp4Template(templates) {
        var want = [/h\.?264.*(匹配渲染设置|match render settings)/i, /h\.?264/i, /mpeg-?4|mp4/i];
        var list = templates || [];
        for (var wi = 0; wi < want.length; wi++) {
            for (var li = 0; li < list.length; li++) {
                if (want[wi].test(String(list[li]))) { return String(list[li]); }
            }
        }
        return "";
    }
    var outExt = _extOf(outputPath);
    if (args.renderPreset) {
        var rt = [], hit = false;
        try { rt = item.templates || []; } catch (e4) { rt = []; }
        for (var r = 0; r < rt.length; r++) { if (String(rt[r]) === String(args.renderPreset)) { hit = true; break; } }
        if (!hit) { _discardNewItem(); return { status: "error", message: "渲染设置预设「" + args.renderPreset + "」不存在。可用：" + (rt.length ? rt.join("、") : "（无）") }; }
        try { item.applyTemplate(String(args.renderPreset)); } catch (e5) { _discardNewItem(); return { status: "error", message: "应用渲染设置预设失败: " + e5 }; }
        out.renderPreset = String(args.renderPreset);
    }
    if (args.outputModulePreset) {
        var ot = [], ohit = false;
        try { ot = om.templates || []; } catch (e6) { ot = []; }
        for (var o = 0; o < ot.length; o++) { if (String(ot[o]) === String(args.outputModulePreset)) { ohit = true; break; } }
        if (!ohit) { _discardNewItem(); return { status: "error", message: "输出模块预设「" + args.outputModulePreset + "」不存在。可用：" + (ot.length ? ot.join("、") : "（无）") }; }
        try { om.applyTemplate(String(args.outputModulePreset)); } catch (e7) { _discardNewItem(); return { status: "error", message: "应用输出模块预设失败: " + e7 }; }
        out.outputModulePreset = String(args.outputModulePreset);
    } else if (outExt === "mp4" || outExt === "m4v") {
        var _omNameNow = "";
        try { _omNameNow = String(om.name || ""); } catch (_eOmName) { _omNameNow = ""; }
        if (!_omMatchesMp4(_omNameNow)) {
            var _omTemplates = [];
            try { _omTemplates = om.templates || []; } catch (_eOmTpl) { _omTemplates = []; }
            var _pickedOm = _pickMp4Template(_omTemplates);
            if (!_pickedOm) {
                // 失败只撤刚建的新项；同合成旧队列项尚未动（见 ② 的延后移除）
                _discardNewItem();
                return {
                    status: "error",
                    message: "输出模块与产物扩展名不兼容（产物 ." + outExt + "，当前输出模块「"
                        + (_omNameNow || "未知") + "」），可用模板里也没有 H.264 类预设（可用："
                        + (_omTemplates.length ? _omTemplates.join("、") : "（无）") + "）。"
                        + "请显式传 outputModulePreset（如「H.264 - 匹配渲染设置 - 15 Mbps」），"
                        + "或改用与当前输出模块匹配的扩展名（如 .mov）。"
                };
            }
            try { om.applyTemplate(_pickedOm); } catch (_eApplyOm) {
                _discardNewItem();
                return { status: "error", message: "应用输出模块预设「" + _pickedOm + "」失败: " + _eApplyOm };
            }
            out.outputModulePreset = _pickedOm;
            out.outputModulePresetAuto = true;
        }
    }
    // ③.5 预设校验全部通过后才移除同合成的旧队列项（新项保留）。顺序=先建后删：
    //     校验失败时旧项原样保留、新项被撤，项目队列回到调用前状态。
    for (var k = q.numItems; k >= 1; k--) {
        var qi = q.item(k);
        if (qi === item) continue;
        try { if (qi.comp && qi.comp === comp) { qi.remove(); removed++; } } catch (e1) { }
    }
    out.removedOldItems = removed;
    try { out.outputModule = String(om.name); } catch (e8) { out.outputModule = ""; }

    // ④ 输出路径（本函数在核 shadow 窗口内运行，须用加载时捕获的真构造器）
    if (!_realFileCtor) { return { status: "error", message: "内部错误：File 构造器未捕获（模块加载异常）" }; }
    try { om.file = new _realFileCtor(outputPath); } catch (e9) { return { status: "error", message: "设置输出路径失败: " + e9 }; }
    var actual = outputPath;
    try { actual = om.file ? String(om.file.fsName) : outputPath; } catch (e10) { actual = outputPath; }
    out.outputPath = actual;

    // ⑤ 覆盖前留一代（框架层的渲染前备份在工具代码之前，覆盖不到这里新设的路径）
    var bk = null;
    try { bk = _backupRenderOutputs(); } catch (e11) { bk = null; }
    out.backup = bk ? { backed: bk.backed, renamed: bk.renamed } : null;

    // ⑥ 渲染（阻塞；对话框抑制由模板层生效）
    var t0 = (new Date()).getTime();
    try { q.render(); } catch (e12) {
        out.status = "error";
        // 渲染失败回执包含「产物扩展名 / 当前输出模块 / 可用输出模块预设」。
        // AE 抛的本地化错误经 evalScript 可能是 GBK 乱码（面板侧已做 GBK 修复，但预设
        // 可用名是确定信息，直接给出，模型不必再靠猜或另起一次调用枚举模板）。
        var _omNameFail = "";
        try { _omNameFail = String(om.name || ""); } catch (_eOmNameFail) { _omNameFail = ""; }
        var _omAvailFail = [];
        try { _omAvailFail = om.templates || []; } catch (_eOmAvailFail) { _omAvailFail = []; }
        out.message = "渲染失败: " + e12
            + "（产物扩展名 ." + outExt + "，当前输出模块「" + (_omNameFail || "未知") + "」；"
            + "可用输出模块预设：" + (_omAvailFail.length ? _omAvailFail.join("、") : "（无）")
            + "。若与输出模块/扩展名不匹配有关，显式传 outputModulePreset 后重试）";
        out.elapsedMs = (new Date()).getTime() - t0;
        return out;
    }
    out.elapsedMs = (new Date()).getTime() - t0;
    try { out.itemStatus = _rqStatusName(item.status); } catch (e13) { }
    // ⑦ 产物落点：序列输出模块会追加帧号（请求 X.png → 实际 X.png00000），
    // 字面路径探测因此必然 productExists=false。改为「精确路径 → 同基名候选」两段：
    //   · 精确路径存在（影片/单文件产物）：直接采用；
    //   · 否则发现同基名序列产物：恰好 1 个且请求扩展名是图片 → 收尾改名为调用方要的
    //     精确文件名（单帧定帧场景）；多个 → 如实回执序列清单，不改名（不能把多帧压成
    //     一个文件）。改名走守卫窗口换槽协议，不新增 file 域能力。
    out.requestedPath = outputPath;
    var products = [];
    try { products = _findRenderProducts(actual, t0); } catch (_eFind) { products = []; }
    var finalProduct = null;
    try {
        var pf = new _realFileCtor(actual);
        if (pf.exists && pf.length >= 0) { finalProduct = { path: String(pf.fsName), size: pf.length }; }
    } catch (e14) { finalProduct = null; }
    var _reqSep = Math.max(outputPath.lastIndexOf("/"), outputPath.lastIndexOf("\\"));
    var _reqDot = outputPath.lastIndexOf(".");
    var _reqExt = (_reqDot > _reqSep + 1) ? outputPath.substring(_reqDot + 1).toLowerCase() : "";
    var _isImageOut = (_reqExt === "png" || _reqExt === "jpg" || _reqExt === "jpeg");
    var renamedFrom = "";
    if (!finalProduct && _isImageOut && products.length === 1) {
        if (_renameInGuardWindow(products[0].path, actual)) {
            renamedFrom = products[0].path;
            try {
                var rf = new _realFileCtor(actual);
                if (rf.exists) { finalProduct = { path: String(rf.fsName), size: rf.length }; }
            } catch (_eRf) { finalProduct = { path: actual, size: products[0].size }; }
        }
    }
    if (!finalProduct && products.length === 1) {
        // 单产物但未改名（请求扩展名非图片 / 改名失败）：如实回执发现到的实际产物路径，
        // 不回填一个不存在的请求路径。
        finalProduct = { path: products[0].path, size: products[0].size };
    }
    out.productExists = !!finalProduct;
    out.productSize = finalProduct ? finalProduct.size : null;
    out.productPath = finalProduct ? finalProduct.path : "";
    out.productCount = (products.length > 0) ? products.length : (finalProduct ? 1 : 0);
    if (renamedFrom) { out.renamedFrom = renamedFrom; }
    if (products.length > 1) {
        // 帧数上限：回执要能被面板/LLM 消费，长序列只列前 100 帧（总数用 productCount 表达）。
        out.products = [];
        var _pLimit = (products.length > 100) ? 100 : products.length;
        for (var pi = 0; pi < _pLimit; pi++) { out.products.push(products[pi].path); }
        out.productNote = "输出模块为序列格式，本次渲染产生 " + products.length
            + " 个帧文件（请求路径前缀 + 帧号），未合并为单文件；按回执 products 逐帧取用"
            + (products.length > _pLimit ? "（products 只列前 " + _pLimit + " 个）" : "") + "。";
    }
    return out;
}

// 读取渲染队列状态。渲染走原生 app.project.renderQueue + render() 后的验证闭环入口
//（不提供便捷入口 addToRenderQueue/startRender）。
// status 取值：QUEUED / RENDERING / DONE / USER_STOPPED / ERR / OK（OK=DONE 别名）
function getRenderQueueInfo(args) {
    try {
        args = args || {};
        var rq = app.project.renderQueue;
        var paging = _parsePaging({ offset: args.itemOffset, limit: args.itemLimit }, 30, 100);
        var allItems = [];
        var n = rq.numItems;
        for (var i = 1; i <= n; i++) {
            var item = rq.item(i);
            var statusStr = (function () { try { return _rqStatusName(item.status); } catch (_) { return ''; } })();
            var entry = {
                index: i,
                compName: (function () { try { return item.comp.name; } catch (_) { return ''; } })(),
                status: statusStr,
                startTime: (function () { try { return item.startTime; } catch (_) { return null; } })(),
                // 官方属性名：timeSpanDuration/elapsedSeconds（duration/elapsedTime 不存在，恒 null）
                duration: (function () { try { return item.timeSpanDuration; } catch (_) { return null; } })(),
                elapsedTime: (function () { try { return item.elapsedSeconds; } catch (_) { return null; } })(),
                outputFilePath: '',
                outputModule: '',
                // 官方属性 render：true=渲染队列启动时会被渲染（status=QUEUED）；skip 属性不存在
                render: (function () { try { return !!item.render; } catch (_) { return null; } })()
            };
            try {
                var om = item.outputModule(1);
                if (om) {
                    try { if (om.file) entry.outputFilePath = String(om.file.fsName); } catch (_) {}
                    try { entry.outputModule = String(om.name); } catch (_) {}
                }
            } catch (_) {}
            try {
                if (item.logType) entry.logType = String(item.logType);
            } catch (_) {}
            allItems.push(entry);
        }
        var startIdx = paging.offset;
        var endIdx = paging.offset + paging.limit;
        if (startIdx > n) startIdx = n;
        if (endIdx > n) endIdx = n;
        var pagedItems = allItems.slice(startIdx, endIdx);
        return {
            status: "success",
            totalCount: n,
            rendering: rq.rendering || false,
            items: pagedItems,
            count: pagedItems.length,
            itemOffset: paging.offset,
            itemLimit: paging.limit,
            hasMore: (paging.offset + paging.limit) < n
        };
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

// 修改相机图层属性。与 createCamera 字段对齐，并补充 Camera Options 组其他常用属性。

// ── 读取类工具重设计：新辅助函数 ──

// 统一图层类型判定（text/shape/camera/light/null/adjustment/av/unknown）
// 渲染队列状态数字码翻译（RQItemStatus 枚举）。用枚举常量引用生成映射，不硬编码数字（跨版本稳定）
function _rqStatusName(s) {
    try {
        if (typeof RQItemStatus === 'undefined') return String(s);
        var st = Number(s);
        var map = {};
        map[RQItemStatus.WILL_CONTINUE] = 'will_continue';
        map[RQItemStatus.UNQUEUED] = 'unqueued';
        map[RQItemStatus.QUEUED] = 'queued';
        map[RQItemStatus.RENDERING] = 'rendering';
        map[RQItemStatus.USER_STOPPED] = 'user_stopped';
        map[RQItemStatus.ERR_STOPPED] = 'error_stopped';
        map[RQItemStatus.DONE] = 'done';
        map[RQItemStatus.NEEDS_OUTPUT] = 'needs_output';
        return map[st] || ('status_' + st);
    } catch (_) { return String(s); }
}

// 混合模式数字码翻译（BlendingMode 枚举）→ 小写常量名。
// 三级兜底：① 硬编码常量名表逐个比数值；② for-in 遍历 BlendingMode 逐键比数值
//（不依赖本机枚举键名与硬编码表一致）；③ 仍未命中才回退原始值字符串。
// 官方拼写不对称：ALPHA 变体是 SILHOUETE（单 T），LUMA 变体是 SILHOUETTE（双 T）；
// 无 LUMINESCENT，只有 LUMINESCENT_PREMUL。
function _blendModeName(v) {
    try {
        if (typeof BlendingMode === 'undefined') return String(v);
        var n = Number(v);
        var names = ['NORMAL','DISSOLVE','DANCING_DISSOLVE','MULTIPLY','SCREEN','OVERLAY','DARKEN','LIGHTEN','COLOR_DODGE','COLOR_BURN','CLASSIC_COLOR_DODGE','CLASSIC_COLOR_BURN','LINEAR_DODGE','LINEAR_BURN','ADD','ALPHA_ADD','SUBTRACT','DIVIDE','HARD_LIGHT','SOFT_LIGHT','VIVID_LIGHT','LINEAR_LIGHT','PIN_LIGHT','HARD_MIX','DIFFERENCE','CLASSIC_DIFFERENCE','EXCLUSION','HUE','SATURATION','COLOR','LUMINOSITY','DARKER_COLOR','LIGHTER_COLOR','STENCIL_ALPHA','STENCIL_LUMA','SILHOUETE_ALPHA','SILHOUETTE_LUMA','LUMINESCENT_PREMUL'];
        for (var i = 0; i < names.length; i++) {
            try { if (BlendingMode[names[i]] === n) return names[i].toLowerCase(); } catch (_) {}
        }
        try {
            for (var k in BlendingMode) {
                try { if (Number(BlendingMode[k]) === n) return String(k).toLowerCase(); } catch (_) {}
            }
        } catch (_) {}
        return String(v);
    } catch (_) { return String(v); }
}

// 自动定向数字码翻译（AutoOrientType 枚举）
function _autoOrientName(v) {
    try {
        if (typeof AutoOrientType === 'undefined') return String(v);
        var n = Number(v);
        var names = ['NO_AUTO_ORIENT', 'ALONG_PATH', 'CAMERA_OR_POINT_OF_INTEREST', 'CHARACTERS_TOWARD_CAMERA'];
        for (var i = 0; i < names.length; i++) {
            try { if (AutoOrientType[names[i]] === n) return names[i].toLowerCase(); } catch (_) {}
        }
        return String(v);
    } catch (_) { return String(v); }
}

function _getLayerType(layer) {
    try {
        if (layer instanceof TextLayer) return "text";
        else if (layer instanceof ShapeLayer) return "shape";
        else if (layer instanceof CameraLayer) return "camera";
        else if (layer instanceof LightLayer) return "light";
        else if (layer instanceof AVLayer) {
            if (layer.nullLayer) return "null";
            else if (layer.adjustmentLayer) return "adjustment";
            else return "av";
        }
    } catch (_) {}
    return "unknown";
}

// 分页辅助：解析 offset/limit，应用默认值和上限（含下限）
// limit 下限 1：0 < v < 1 时 `v > 0 ? Math.floor(v)` 得 0 → 空页 + hasMore=true，
// offset 不前进（调用方按 hasMore 续页会原地死循环）。非 number/非有限/≤0 仍回退默认值。
function _parsePaging(args, defaultLimit, maxLimit) {
    var offset = (typeof args.offset === "number" && isFinite(args.offset) && args.offset > 0)
        ? Math.floor(args.offset) : 0;
    var limit = (typeof args.limit === "number" && isFinite(args.limit) && args.limit > 0)
        ? Math.max(1, Math.floor(args.limit)) : defaultLimit;
    if (limit > maxLimit) limit = maxLimit;
    return { offset: offset, limit: limit };
}

// 浏览项目面板内容：folderIndex 不传查根目录，depth 递归，typeFilter/nameFilter 过滤，分页
function browseProject(args) {
    try {
        args = args || {};
        var folderIndex = args.folderIndex !== undefined ? Number(args.folderIndex) : 0;
        var depth = args.depth !== undefined ? Number(args.depth) : 1;
        if (depth === 0) depth = 1;
        var typeFilter = args.typeFilter ? String(args.typeFilter).toLowerCase() : '';
        var nameFilter = args.nameFilter ? String(args.nameFilter).toLowerCase() : '';
        var paging = _parsePaging({ offset: args.itemOffset, limit: args.itemLimit }, 30, 100);

        // 定位目标文件夹：folderIndex 指向非文件夹/越界时显式报错，避免静默回退根目录误导 LLM
        var rootFolder = app.project.rootFolder;
        var targetFolder = rootFolder;
        var folderPath = "Root";
        if (folderIndex > 0) {
            if (folderIndex > app.project.numItems) {
                return { status: "error", message: "folderIndex " + folderIndex + " 超出项目条目数 " + app.project.numItems };
            }
            var fi = app.project.item(folderIndex);
            if (!(fi instanceof FolderItem)) {
                return { status: "error", message: "folderIndex " + folderIndex + " 指向的不是文件夹（type=" + fi.typeName + "）" };
            }
            targetFolder = fi;
            var parts = [];
            var cur = fi;
            while (cur && cur !== rootFolder) {
                parts.unshift(cur.name);
                try { cur = cur.parentFolder; } catch (_) { break; }
            }
            folderPath = parts.length > 0 ? parts.join(" / ") : "Root";
        }

        // 递归收集子项（每层独立分页：顶层用 paging，子层用同 limit 截断）
        // 契约要求「仅当前层分页，子层超出直接截断」——子层只保留前 limit 个，超出丢弃，
        // LLM 可通过 folderIndex 深入子文件夹获取完整内容。
        // 返回给 LLM 的数据有顶层 slice + CHILD_LIMIT 双重限制不会爆上下文，
        // 但递归遍历本身在深度嵌套时会指数增长（30^5≈2400万次 folder.item() 调用）卡死 AE 主线程，
        // TOTAL_HARD_LIMIT 是 ExtendScript 侧的保护，限制递归遍历的总条目数。
        var CHILD_LIMIT = paging.limit;
        var TOTAL_HARD_LIMIT = 200;  // 递归遍历总条目上限，超出后停止递归（防 AE 卡死）
        var totalCollected = 0;
        var totalCompCount = 0;  // 全项目合成数统计（含文件夹内，受 TOTAL_HARD_LIMIT 保护）
        var truncatedByHardLimit = false;
        var truncatedFolder = '';  // 触发硬上限时正在遍历的文件夹路径（提示 LLM 卡在哪一层）
        function collectItems(folder, currentDepth, maxDepth, pathLabel) {
            var items = [];
            var n = folder.numItems;
            for (var i = 1; i <= n; i++) {
                // 总条目硬上限检查：超出后立即停止收集，标记 truncated
                if (totalCollected >= TOTAL_HARD_LIMIT) {
                    truncatedByHardLimit = true;
                    if (!truncatedFolder) truncatedFolder = pathLabel;
                    break;
                }
                var item = folder.item(i);
                if (item instanceof FolderItem) {
                    // 文件夹作为结构始终保留+递归，typeFilter/nameFilter 只对 comp/footage 生效
                    // 条目带 id（Item.id）——index 会随项目面板增删/重排移位，id 稳定。
                    var entry = { index: _getItemIndex(item), id: _readItemId(item), name: item.name, type: 'folder', numItems: item.numItems };
                    if (maxDepth === -1 || currentDepth < maxDepth) {
                        var children = collectItems(item, currentDepth + 1, maxDepth, pathLabel + ' / ' + item.name);
                        // 子层截断：超出 CHILD_LIMIT 直接丢弃，标记 truncatedCount
                        if (children.length > CHILD_LIMIT) {
                            entry.children = children.slice(0, CHILD_LIMIT);
                            entry.truncatedCount = children.length - CHILD_LIMIT;
                        } else {
                            entry.children = children;
                        }
                    }
                    items.push(entry);
                    totalCollected++;
                } else if (item instanceof CompItem) {
                    // totalComps 不受 typeFilter/nameFilter 影响：表示该文件夹下真实合成总数
                    totalCompCount++;
                    if (typeFilter && typeFilter !== 'comp') continue;
                    if (nameFilter && String(item.name).toLowerCase().indexOf(nameFilter) < 0) continue;
                    items.push({ index: _getItemIndex(item), id: _readItemId(item), name: item.name, type: 'comp', width: item.width, height: item.height, duration: item.duration, frameRate: item.frameRate, numLayers: item.numLayers });
                    totalCollected++;
                } else if (item instanceof FootageItem) {
                    if (typeFilter && typeFilter !== 'footage') continue;
                    if (nameFilter && String(item.name).toLowerCase().indexOf(nameFilter) < 0) continue;
                    var fp = '';
                    var fkind = 'footage';
                    try {
                        var ms = item.mainSource;
                        if (ms) {
                            if (ms instanceof FileSource) { fkind = 'file'; if (ms.file) fp = String(ms.file.fsName); }
                            else if (ms instanceof SolidSource) fkind = 'solid';
                            else if (ms instanceof PlaceholderSource) fkind = 'placeholder';
                        }
                    } catch (_) {}
                    items.push({ index: _getItemIndex(item), id: _readItemId(item), name: item.name, type: 'footage', footageKind: fkind, duration: item.duration, width: item.width, height: item.height, hasVideo: item.hasVideo, hasAudio: item.hasAudio, filePath: fp });
                    totalCollected++;
                }
            }
            return items;
        }

        var allItems = collectItems(targetFolder, 1, depth, folderPath);
        var totalCount = allItems.length;
        var startIdx = paging.offset;
        var endIdx = paging.offset + paging.limit;
        if (startIdx > totalCount) startIdx = totalCount;
        if (endIdx > totalCount) endIdx = totalCount;
        var pagedItems = allItems.slice(startIdx, endIdx);

        var result = {
            status: "success",
            folderPath: folderPath,
            items: pagedItems,
            count: pagedItems.length,
            totalCount: totalCount,
            totalComps: totalCompCount,
            itemOffset: paging.offset,
            itemLimit: paging.limit,
            hasMore: (paging.offset + paging.limit) < totalCount
        };
        if (truncatedByHardLimit) {
            result.truncated = true;
            result.truncatedFolder = truncatedFolder;
            result.truncatedReason = '总条目数超过 ' + TOTAL_HARD_LIMIT + ' 上限，已停止递归'
                + (truncatedFolder ? '（在 "' + truncatedFolder + '" 内触发）' : '')
                + '。请用 folderIndex 逐级浏览子文件夹获取完整内容';
        }
        return result;
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

// references 引用链：查找哪些图层的 source 指向 targetItem，递归向上追嵌套合成
function _findCompParents(comp, currentDepth, maxDepth, maxBreadth) {
    var parents = [];
    for (var i = 1; i <= app.project.numItems; i++) {
        var pc = app.project.item(i);
        if (!(pc instanceof CompItem) || pc === comp) continue;
        for (var j = 1; j <= pc.numLayers; j++) {
            try {
                var layer = pc.layer(j);
                if (layer instanceof AVLayer && layer.source === comp) {
                    var node = {
                        // Item 对象无 index 属性，必须用 _getItemIndex 取项目面板索引
                        compIndex: _getItemIndex(pc), compName: pc.name,
                        layerIndex: layer.index, layerName: layer.name,
                        parents: []
                    };
                    if (currentDepth < maxDepth) {
                        node.parents = _findCompParents(pc, currentDepth + 1, maxDepth, maxBreadth);
                        // 嵌套层广度截断提示：parents 达到 maxBreadth 上限时该层链路可能不完整
                        if (node.parents.length >= maxBreadth) node.childrenTruncated = true;
                    }
                    parents.push(node);
                    if (parents.length >= maxBreadth) return parents;
                }
            } catch (_) {}
        }
    }
    return parents;
}

function _findSourceRefs(targetItem) {
    var maxDepth = 10, maxBreadth = 200;
    var refs = [];
    var truncated = false;
    for (var i = 1; i <= app.project.numItems; i++) {
        var comp = app.project.item(i);
        if (!(comp instanceof CompItem)) continue;
        for (var j = 1; j <= comp.numLayers; j++) {
            try {
                var layer = comp.layer(j);
                if (layer instanceof AVLayer && layer.source === targetItem) {
                    var ref = {
                        compIndex: i, compName: comp.name,
                        layerIndex: layer.index, layerName: layer.name,
                        parents: _findCompParents(comp, 2, maxDepth, maxBreadth)
                    };
                    refs.push(ref);
                    if (refs.length >= maxBreadth) { truncated = true; return { refs: refs, truncated: true }; }
                }
            } catch (_) {}
        }
    }
    return { refs: refs, truncated: truncated };
}

// 合成标记
function _getCompMarkers(comp) {
    var markers = [];
    try {
        var mp = comp.markerProperty;
        var n = mp.numKeys;
        for (var i = 1; i <= n; i++) {
            var mv = mp.keyValue(i);
            markers.push({ index: i, time: mp.keyTime(i), comment: mv.comment || "", duration: mv.duration || 0, chapter: mv.chapter || "", url: mv.url || "", frameTarget: mv.frameTarget || "", cuePointName: mv.cuePointName || "" });
        }
    } catch (_) {}
    return markers;
}

// 图层标记
// 无上限时单层 500 标记 × 8 字段约 40KB，opt-in 也会越过 28KB 兜底线。
// 现在单层最多 LAYER_MARKER_CAP=100 条；state 回传真实总数与是否截断，由调用方补
// markersTotal/markersTruncated 并把字节计入响应级总预算。
function _getLayerMarkers(layer, state) {
    var LAYER_MARKER_CAP = 100;
    var markers = [];
    try {
        var mp = getPropSafe(layer, "Marker");
        if (mp) {
            var n = 0;
            try { n = Number(mp.numKeys) || 0; } catch (_) { n = 0; }
            if (state && typeof state === "object") state.total = n;
            if (n > LAYER_MARKER_CAP) {
                n = LAYER_MARKER_CAP;
                if (state && typeof state === "object") state.truncated = true;
            }
            for (var i = 1; i <= n; i++) {
                var mv = mp.keyValue(i);
                markers.push({ index: i, time: mp.keyTime(i), comment: mv.comment || "", duration: mv.duration || 0, chapter: mv.chapter || "", url: mv.url || "", frameTarget: mv.frameTarget || "", cuePointName: mv.cuePointName || "" });
            }
        }
    } catch (_) {}
    return markers;
}

// 图层类型统计
function _getLayerTypeCounts(comp) {
    var counts = {};
    for (var i = 1; i <= comp.numLayers; i++) {
        var t = _getLayerType(comp.layer(i));
        counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
}

// 合成详情（支持批量）+ references + markers
function getCompInfo(args) {
    try {
        args = args || {};
        // fields 组选择：只决定"返回哪些块"；未传 = 现有默认，迭代与 include* 开关
        // 完全不变；"*" = 全量组；未知 field / 形态错误报错并列出合法清单（校验与清单在 _parseFieldsArg）。
        // markers/references/timeline 同理：fields 里出现即等价开启，不出现则即使对应 boolean 为 true 也不返回。
        var _fieldsParsed = _parseFieldsArg(args.fields, "comp", "base");
        if (!_fieldsParsed.ok) return { status: "error", message: _fieldsParsed.message };
        var _fieldSet = _fieldsParsed.fieldSet;
        var _fieldAll = _fieldsParsed.all;
        function _fieldOn(name) {
            if (_fieldSet === null) return false;
            if (_fieldAll) return true;
            return _fieldSet[name] === true;
        }
        var wantBase = (_fieldSet === null) ? true : _fieldOn("base");
        var wantRefs = (_fieldSet === null) ? (args.references === true) : _fieldOn("references");
        var wantMarkers = (_fieldSet === null) ? (args.markers === true) : _fieldOn("markers");
        // comp 级事件表（opt-in）：一次给出整段合成的时间密度——关键帧时刻、图层入出点、
        // 可选合成标记。只读 numKeys/keyTime 与入出点，不读值、不读 ease/插值；逐层完整
        // 轨道仍属 target=layer。批量 compositionIds 时每个合成各算一份。
        // 时间基统一为合成时间：关键帧 time = layer.startTime + keyTime（layerTime 保留层本地秒），
        // 与 layerIn/layerOut/marker 同轴；stretch≠100 的层跳过关键帧并列入 timelineNonLinearSkipped。
        var wantTimeline = (_fieldSet === null) ? (args.includeTimeline === true) : _fieldOn("timeline");
        var timelinePaging = _parsePaging({ offset: args.timelineOffset, limit: args.timelineLimit }, 100, 500);
        // 事件表响应级字节预算：只限条数时 500 条一页 88,514 字符、两合成默认
        // 35,962——默认参数就能越过 agent 管线 32K 截断线。这里按事件 JSON 长度收缩本页，
        // 置 timelineBytesTruncated；timelineTotal 是稳定的可翻页总数（只受事件硬上限 5000
        // 影响，不随本页字节收缩漂移），截断前真实数仍在 timelineScannedTotal；本页实际条数看
        // events.length，续页用 timelineNextOffset。nestedLayers 另外限量 100 条（300 precomp
        // 层时单页 30,545 字符，且每页重复同一份），真实条数看 timelineNestedTotal。
        var TIMELINE_BYTE_BUDGET = 12000;
        var TIMELINE_NESTED_CAP = 100;
        // nestedLayers 分页：timelineNestedNextOffset 需配可消费的
        // 参数（nestedLayers 每次从 0 开始）。新增 timelineNestedOffset（默认 0，口径同
        // _parsePaging：仅 number 且有限且 >0 才接受，正数取整），在切片上生效；每页上限仍是
        // TIMELINE_NESTED_CAP=100，输出 timelineNestedOffset/timelineNestedNextOffset
        //（下一批起点 = 本页起点 + 本页实际返回条数）。
        var timelineNestedPaging = _parsePaging({ offset: args.timelineNestedOffset, limit: TIMELINE_NESTED_CAP }, TIMELINE_NESTED_CAP, TIMELINE_NESTED_CAP);
        // 响应级事件预算：每个 comp 各建一份 12KB 预算时批量
        // 成倍溢出——5 个事件密集合成（各 300 层×5 事件）默认页 63,985B，5 个各 300 precomp 层的
        // 合成 52,280B（nestedLayers 完全不进预算）。现在整响应共用一份 used：每个 comp 的
        // timeline 元数据 + events + nestedLayers 都从中扣，剩余额度不足就收缩后续 comp 的
        // events 页并置该 comp timelineBytesTruncated，结果级也置 timelineBytesTruncated；
        // 保证单响应事件部分（events + nestedLayers + 各 comp 的 timeline 字段）≤12KB。
        // 每响应重置，所以按 timelineOffset/timelineNextOffset 续读仍可用（被前面的 comp 吃光
        // 额度、本页 0 条的 comp 会带 timelineEventsStarved，改用单个 compositionId 单独续读）。
        var _tlRespBudget = { used: 0, exhausted: false };
        // 待分配事件的合成（元数据已建好，events/nestedLayers 留空；分配在两阶段后进行）
        var _tlPending = [];
        var paging = _parsePaging({ offset: args.itemOffset, limit: args.itemLimit }, 5, 10);

        // 事件收集（getCompInfo 内局部函数，不新增顶层声明）。
        // 只扫 cmp.numLayers 层，不递归子合成——嵌套层只记 source 供调用方决定是否下钻。
        // 事件上限 EVENT_CAP 条：先收集后排序，超限按排序结果截断并置 capped；分页在截断后
        // 的数组上做（timelineTotal 因此是"可翻页总数"；截断前真实条数见 timelineScannedTotal）。
        function buildCompTimeline(cmp, opts) {
            var EVENT_CAP = 5000;
            // stretch≠100 的层关键帧不进事件表（层本地时间→合成时间非线性，不猜换算）：
            // 记录被跳过的层 index，上限 NON_LINEAR_CAP 条，超出只累计 nonLinearTotal。每层最多记一次。
            var NON_LINEAR_CAP = 100;
            var nonLinearSkipped = [];
            var nonLinearSeen = {};
            var nonLinearTotal = 0;
            var events = [];
            var nested = [];
            var capped = false;
            var frameRate = 1;
            try { frameRate = Number(cmp.frameRate) || 1; } catch (_) {}
            // 族名只在真扫到属性时进 scope（timelineUnscanned 是补集，没扫的不许报 0）
            var scanned = { transform: false, timeRemap: false, mask: false, sourceText: false, textAnimatorParams: false };
            // 按族计数：没有的族恒给 0（与 timelineScope"只列扫到的族"互补——
            // scope 说明"扫过哪些族"，counts 说明"每族多少条事件"）。计数在截断前累加，
            // 各族之和 = timelineScannedTotal。
            var counts = {
                transform: 0, timeRemap: 0, mask: 0, sourceText: 0, textAnimatorParams: 0,
                layerIn: 0, layerOut: 0, marker: 0
            };
            // 合成时间轴帧：frame = round(合成秒 * frameRate)
            function frameOf(sec) { return Math.round(Number(sec) * frameRate); }
            function kindRank(kind) {
                if (kind === "layerIn") return 0;
                if (kind === "layerOut") return 1;
                if (kind === "keyframe") return 2;
                return 3;
            }
            // 一个关键帧一条事件：只读 numKeys/keyTime。属性存在但无关键帧也算"族已扫到"。
            // evOpts.family → 计入 counts；evOpts.maskIndex/maskName → 只挂在蒙版 keyframe 上
            //（1-based 序号 + 蒙版名，同层多蒙版可定位；非蒙版事件不带这两个字段）。
            // 时间基：prop.keyTime 是层本地秒，事件表统一到合成时间——
            // time = layerStartTime + keyTime（合成秒）、frame = round(time × frameRate)、
            // layerTime 保留层本地秒（与 layerIn/layerOut/marker 同一时间轴，不再混基）。
            // evOpts.layerNonLinear（stretch≠100）时层时间→合成时间非线性：不产关键帧事件，
            // 只把该层 layerIndex 记进 nonLinearSkipped（每层一次，上限 NON_LINEAR_CAP）。
            function pushKeys(prop, label, matchName, layerIndex, layerId, layerName, evOpts) {
                if (!prop) return false;
                var n = 0;
                try { n = Number(prop.numKeys); } catch (_) { return false; }
                var fam = evOpts ? evOpts.family : "";
                var mIdx = evOpts ? evOpts.maskIndex : 0;
                var mName = evOpts ? evOpts.maskName : "";
                var startT = evOpts ? (Number(evOpts.layerStartTime) || 0) : 0;
                var nonLinear = (evOpts && evOpts.layerNonLinear === true);
                if (nonLinear) {
                    if (n > 0) {
                        var seenKey = String(layerIndex);
                        if (!nonLinearSeen[seenKey]) {
                            nonLinearSeen[seenKey] = true;
                            nonLinearTotal++;
                            if (nonLinearSkipped.length < NON_LINEAR_CAP) nonLinearSkipped.push(layerIndex);
                        }
                    }
                    return true;   // 属性扫过但不产事件：族标记照置，counts 不累加
                }
                for (var i = 1; i <= n; i++) {
                    var t = 0;
                    try { t = Number(prop.keyTime(i)); } catch (_) { continue; }
                    var compT = startT + t;
                    var ev = {
                        frame: frameOf(compT), time: compT, layerTime: t, kind: "keyframe",
                        layerIndex: layerIndex, layerId: layerId, layerName: layerName,
                        property: label, propertyMatchName: matchName
                    };
                    if (mIdx > 0) { ev.maskIndex = mIdx; ev.maskName = mName; }
                    events.push(ev);
                    if (fam && counts[fam] !== undefined) counts[fam]++;
                }
                return true;
            }
            // 展开一组可动画属性（动画器属性组）：属性名与 matchName 逐项收集
            // lctx = 层时间上下文 {startTime, nonLinear}，逐层透传给 pushKeys（统一合成时间基）
            function scanLeaves(group, layerIndex, layerId, layerName, lctx) {
                var n = 0;
                try { n = Number(group.numProperties) || 0; } catch (_) { return; }
                for (var i = 1; i <= n; i++) {
                    var p = null;
                    try { p = group.property(i); } catch (_) {}
                    if (!p) continue;
                    var pName = "", pMatch = "";
                    try { pName = String(p.name || ""); } catch (_) {}
                    try { pMatch = String(p.matchName || ""); } catch (_) {}
                    if (pushKeys(p, pName || pMatch, pMatch || pName, layerIndex, layerId, layerName,
                        { family: "textAnimatorParams", layerStartTime: lctx.startTime, layerNonLinear: lctx.nonLinear })) {
                        scanned.textAnimatorParams = true;
                    }
                }
            }
            function scanPropGroup(parent, groupMatchName, layerIndex, layerId, layerName, lctx) {
                var group = null;
                try { group = parent.property(groupMatchName); } catch (_) {}
                if (group) scanLeaves(group, layerIndex, layerId, layerName, lctx);
            }
            // 范围选择器属性（起始/结束/偏移等）：选择器本身是分组，可动画属性在其下一层
            function scanSelectors(animator, layerIndex, layerId, layerName, lctx) {
                var selectors = null;
                try { selectors = animator.property("ADBE Text Selectors"); } catch (_) {}
                if (!selectors) return;
                var n = 0;
                try { n = Number(selectors.numProperties) || 0; } catch (_) {}
                for (var i = 1; i <= n; i++) {
                    var sel = null;
                    try { sel = selectors.property(i); } catch (_) {}
                    if (sel) scanLeaves(sel, layerIndex, layerId, layerName, lctx);
                }
            }
            // 文本动画器：动画器属性 + 范围选择器属性（起始/结束百分比的关键帧就在选择器里）
            function scanTextAnimators(animators, layerIndex, layerId, layerName, lctx) {
                var anCount = 0;
                try { anCount = Number(animators.numProperties) || 0; } catch (_) { return; }
                for (var ai = 1; ai <= anCount; ai++) {
                    var animator = null;
                    try { animator = animators.property(ai); } catch (_) {}
                    if (!animator) continue;
                    scanPropGroup(animator, "ADBE Text Animator Properties", layerIndex, layerId, layerName, lctx);
                    scanSelectors(animator, layerIndex, layerId, layerName, lctx);
                }
            }
            var transformNames = ["Position", "Scale", "Rotation", "Opacity", "Anchor Point", "Audio Levels"];
            var maskNames = ["Mask Path", "Mask Feather", "Mask Opacity", "Mask Expansion"];
            var numLayers = 0;
            try { numLayers = Number(cmp.numLayers) || 0; } catch (_) {}
            for (var li = 1; li <= numLayers; li++) {
                var layer = null;
                try { layer = cmp.layer(li); } catch (_) {}
                if (!layer) continue;
                // 图层身份只读一次（宿主属性访问按次计费，逐事件读会成倍放大成本）
                var layerIndex = li, layerId = 0, layerName = "";
                try { layerIndex = Number(layer.index) || li; } catch (_) { layerIndex = li; }
                try { layerId = _readLayerId(layer); } catch (_) { layerId = 0; }
                try { layerName = String(layer.name || ""); } catch (_) { layerName = ""; }
                // 时间基：keyTime 是层本地秒，事件统一到合成时间 = startTime + keyTime；
                // stretch≠100 时该换算非线性，关键帧事件跳过并把层记进 nonLinearSkipped（不猜公式）
                var layerStartTime = 0;
                try { layerStartTime = Number(layer.startTime) || 0; } catch (_) { layerStartTime = 0; }
                var layerStretch = 100;
                try { layerStretch = Number(layer.stretch); } catch (_) { layerStretch = 100; }
                if (isNaN(layerStretch)) layerStretch = 100;
                var lctx = { startTime: layerStartTime, nonLinear: (layerStretch !== 100) };
                // 入出点（合成时间轴）
                try {
                    var inT = Number(layer.inPoint);
                    events.push({ frame: frameOf(inT), time: inT, kind: "layerIn", layerIndex: layerIndex, layerId: layerId, layerName: layerName });
                    counts.layerIn++;
                } catch (_) {}
                try {
                    var outT = Number(layer.outPoint);
                    events.push({ frame: frameOf(outT), time: outT, kind: "layerOut", layerIndex: layerIndex, layerId: layerId, layerName: layerName });
                    counts.layerOut++;
                } catch (_) {}
                // 嵌套合成：只记录来源，不展开其内部图层
                try {
                    var src = layer.source;
                    if (src instanceof CompItem) {
                        nested.push({
                            layerIndex: layerIndex, layerId: layerId, name: layerName,
                            sourceCompId: _readItemId(src), sourceCompName: String(src.name || "")
                        });
                    }
                } catch (_) {}
                // 5 个变换属性 + Audio Levels（getPropSafe：matchName 优先，兼容中文 AE；
                // Audio Levels 在 ADBE Audio Group 下，由 getPropSafe 的组回退读取）
                for (var ti = 0; ti < transformNames.length; ti++) {
                    var tProp = null;
                    try { tProp = getPropSafe(layer, transformNames[ti]); } catch (_) {}
                    var tLabel = transformNames[ti];
                    if (pushKeys(tProp, tLabel, ADBE_MATCH[tLabel] || tLabel, layerIndex, layerId, layerName,
                        { family: "transform", layerStartTime: lctx.startTime, layerNonLinear: lctx.nonLinear })) {
                        scanned.transform = true;
                    }
                }
                // 时间重映射：仅 AVLayer 且已启用时属性存在
                try {
                    if (layer instanceof AVLayer && layer.timeRemapEnabled) {
                        var trProp = getPropSafe(layer, "Time Remap");
                        if (pushKeys(trProp, "Time Remap", ADBE_MATCH["Time Remap"] || "ADBE Time Remapping", layerIndex, layerId, layerName,
                            { family: "timeRemap", layerStartTime: lctx.startTime, layerNonLinear: lctx.nonLinear })) {
                            scanned.timeRemap = true;
                        }
                    }
                } catch (_) {}
                // 蒙版：路径 / 羽化 / 不透明度 / 扩展（事件带 maskIndex/maskName 供同层多蒙版定位）
                var maskGroup = null;
                try { maskGroup = getPropSafe(layer, "Masks"); } catch (_) {}
                if (maskGroup) {
                    var maskCount = 0;
                    try { maskCount = Number(maskGroup.numProperties) || 0; } catch (_) {}
                    for (var mi = 1; mi <= maskCount; mi++) {
                        var mask = null;
                        try { mask = maskGroup.property(mi); } catch (_) {}
                        if (!mask) continue;
                        var maskName = "";
                        try { maskName = String(mask.name || ""); } catch (_) { maskName = ""; }
                        for (var mj = 0; mj < maskNames.length; mj++) {
                            var mProp = null;
                            try { mProp = getPropSafe(mask, maskNames[mj]); } catch (_) {}
                            var mLabel = maskNames[mj];
                            if (pushKeys(mProp, mLabel, ADBE_MATCH[mLabel] || mLabel, layerIndex, layerId, layerName,
                                { family: "mask", maskIndex: mi, maskName: maskName, layerStartTime: lctx.startTime, layerNonLinear: lctx.nonLinear })) {
                                scanned.mask = true;
                            }
                        }
                    }
                }
                // 文本：Source Text 关键帧 + 文本动画器属性关键帧
                try {
                    if (layer instanceof TextLayer) {
                        var textProps = layer.property("ADBE Text Properties");
                        if (textProps) {
                            var srcText = null;
                            try { srcText = textProps.property("ADBE Text Document"); } catch (_) {}
                            if (pushKeys(srcText, "Source Text", ADBE_MATCH["Source Text"] || "ADBE Text Document", layerIndex, layerId, layerName,
                                { family: "sourceText", layerStartTime: lctx.startTime, layerNonLinear: lctx.nonLinear })) {
                                scanned.sourceText = true;
                            }
                            var animators = null;
                            try { animators = textProps.property("ADBE Text Animators"); } catch (_) {}
                            if (animators) scanTextAnimators(animators, layerIndex, layerId, layerName, lctx);
                        }
                    }
                } catch (_) {}
            }
            // 合成标记：markers:true 才并入，markerName 取注释（AE 标记没有独立名称字段）。
            // 标记不属于任何图层，layerIndex/layerId 置 0、layerName 置空。
            if (opts && opts.markers) {
                try {
                    var markerProp = cmp.markerProperty;
                    var markerCount = 0;
                    try { markerCount = Number(markerProp.numKeys) || 0; } catch (_) {}
                    for (var ki = 1; ki <= markerCount; ki++) {
                        var mTime = 0;
                        try { mTime = Number(markerProp.keyTime(ki)); } catch (_) { continue; }
                        var markerName = "";
                        try {
                            var mv = markerProp.keyValue(ki);
                            markerName = String((mv && mv.comment) || "");
                        } catch (_) {}
                        events.push({
                            frame: frameOf(mTime), time: mTime, kind: "marker",
                            layerIndex: 0, layerId: 0, layerName: "", markerName: markerName
                        });
                        counts.marker++;
                    }
                } catch (_) {}
            }
            // 排序：frame 升序 → layerIndex 升序 → kind 固定序（layerIn/layerOut/keyframe/marker）
            events.sort(function (a, b) {
                if (a.frame !== b.frame) return a.frame - b.frame;
                if (a.layerIndex !== b.layerIndex) return a.layerIndex - b.layerIndex;
                return kindRank(a.kind) - kindRank(b.kind);
            });
            // 截断前真实条数：timelineTotal 是"截断后可翻页总数"，两者只在未截断时相等
            var scannedTotal = events.length;
            if (events.length > EVENT_CAP) {
                events = events.slice(0, EVENT_CAP);
                capped = true;
            }
            var scope = [];
            if (scanned.transform) scope.push("transform");
            if (scanned.timeRemap) scope.push("timeRemap");
            if (scanned.mask) scope.push("mask");
            if (scanned.sourceText) scope.push("sourceText");
            if (scanned.textAnimatorParams) scope.push("textAnimatorParams");
            return {
                events: events, scope: scope, nested: nested, capped: capped, counts: counts, scannedTotal: scannedTotal,
                // stretch≠100 的层不产关键帧事件：列出其 layerIndex（上限 NON_LINEAR_CAP 条，
                // 超出只累计 total；total 也是去重后的层数）
                nonLinearSkipped: nonLinearSkipped, nonLinearSkippedTotal: nonLinearTotal
            };
        }

        // 收集目标合成：compositionId(s)（稳定键，优先）或 compositionIndex(/Indices)/compIndex（位置键）
        var targets = [];
        if (args.compositionIds !== undefined && args.compositionIds !== null) {
            // 批量：形态/空数组/元素校验统一走 _resolveItemIds（公共 helper：与
            // layerIds / footageIds / queryProject(overview) 的 compositionIds 同一份契约与文案）——
            // 必须是数组且非空；元素仅 number 或纯数字字符串的正整数，布尔/数组/对象/浮点报错
            // 点名第几项（Math.floor(Number(true)) → 1 会命中 id=1 的条目）。
            var _cidParsed = _resolveItemIds(args.compositionIds, "compositionIds");
            if (_cidParsed.error) return { status: "error", message: _cidParsed.error };
            var missingCompIds = [];
            for (var cid = 0; cid < _cidParsed.ids.length; cid++) {
                var byIdComp = _findItemById(_cidParsed.ids[cid]);
                if (byIdComp instanceof CompItem) targets.push({ comp: byIdComp, index: _getItemIndex(byIdComp) });
                else missingCompIds.push(String(_cidParsed.ids[cid]));
            }
            if (missingCompIds.length > 0) {
                // 批量缺 id 的文案按 label 统一（与 overview 的 compositionIds 分支逐字一致）
                return { status: "error", message: "compositionIds 找不到对应合成（可能已删除）: " + missingCompIds.join(", ") };
            }
        } else if (args.compositionId !== undefined && args.compositionId !== null) {
            // 单值 compositionId：走 _resolveStrictComp——包成 [id] 交给
            // _resolveItemIds，字符串 "922" 按元素契约归一后 success，与 layer/effect/overview
            // 的「须为 number」两套语义并存。数组路径的元素契约不变（纯数字字符串仍接受）。
            var _rcCompId = _resolveStrictComp(args, false);
            if (_rcCompId.error) return { status: "error", message: _rcCompId.error };
            targets.push({ comp: _rcCompId.comp, index: _rcCompId.compIdx });
        } else {
            var indices = [];
            if (args.compositionIndices !== undefined && args.compositionIndices !== null) {
                // 形态与值域校验：只判真值再按 .length 遍历时，
                // 字符串 "1,2" 被逐字符拆成 [1,2]（返回 comps=[1]，静默半批），越界/非合成条目
                // 被 continue 静默丢掉。现在非数组报错，元素须是 1..numItems 的正整数且指向合成，
                // 任一无效即整批报错（口径对齐 compositionIds）。
                if (!_isArrayValue(args.compositionIndices)) return { status: "error", message: "compositionIndices 需为数组" };
                if (args.compositionIndices.length === 0) {
                    return { status: "error", message: "compositionIndices 不能为空数组" };
                }
                for (var cix = 0; cix < args.compositionIndices.length; cix++) {
                    var ciRaw = args.compositionIndices[cix];
                    var ciVal = (typeof ciRaw === "number") ? ciRaw : NaN;
                    if (!isFinite(ciVal) || ciVal !== Math.floor(ciVal) || ciVal < 1) {
                        return { status: "error", message: "compositionIndices 第 " + (cix + 1) + " 项不是正整数索引: " + String(ciRaw) };
                    }
                    if (ciVal > app.project.numItems) {
                        return { status: "error", message: "compositionIndices 第 " + (cix + 1) + " 项越界: " + ciVal + "（项目条目数 " + app.project.numItems + "）" };
                    }
                    if (!(app.project.item(ciVal) instanceof CompItem)) {
                        return { status: "error", message: "compositionIndices 第 " + (cix + 1) + " 项不是合成: " + ciVal };
                    }
                    indices.push(ciVal);
                }
            } else if ((args.compositionIndex !== undefined && args.compositionIndex !== null) ||
                       (args.compIndex !== undefined && args.compIndex !== null)) {
                // 单值复用 _resolveStrictComp（公共 helper 与
                // layer/effect 共用）：值必须是 number 正整数，越界/非合成/0/浮点/布尔/字符串
                // 报错并点明收到的值与键名（Number(...) + isNaN 之外整数一律进入 indices，
                // 越界后 continue，最终 success/totalCount=0）。
                var _rcSingleComp = _resolveStrictComp(args, false);
                if (_rcSingleComp.error) return { status: "error", message: _rcSingleComp.error };
                targets.push({ comp: _rcSingleComp.comp, index: _rcSingleComp.compIdx });
            } else {
                return { status: "error", message: "需要 compositionIndex / compositionIndices 或 compositionId" };
            }
            for (var ci = 0; ci < indices.length; ci++) {
                var idx = indices[ci];
                if (idx < 1 || idx > app.project.numItems) continue;
                var compAtIdx = app.project.item(idx);
                if (compAtIdx instanceof CompItem) targets.push({ comp: compAtIdx, index: idx });
            }
        }

        var allComps = [];
        for (var ti = 0; ti < targets.length; ti++) {
            var idx = targets[ti].index;
            var comp = targets[ti].comp;
            var info = {};
            if (wantBase) {
                info = {
                    index: idx, id: _readItemId(comp), name: comp.name,
                    width: comp.width, height: comp.height,
                    duration: comp.duration, frameRate: comp.frameRate,
                    numLayers: comp.numLayers, pixelAspect: comp.pixelAspect,
                    workAreaStart: comp.workAreaStart, workAreaDuration: comp.workAreaDuration,
                    displayStartTime: comp.displayStartTime,
                    bgColor: (function () { try { return comp.bgColor; } catch (_) { return null; } })(),
                    shutterAngle: (function () { try { return comp.shutterAngle; } catch (_) { return null; } })(),
                    motionBlur: (function () { try { return !!comp.motionBlur; } catch (_) { return false; } })(),
                    frameBlending: (function () { try { return !!comp.frameBlending; } catch (_) { return false; } })(),
                    layerTypeCounts: _getLayerTypeCounts(comp)
                };
            }
            if (wantMarkers) info.markers = _getCompMarkers(comp);
            if (wantTimeline) {
                var tl = buildCompTimeline(comp, { markers: wantMarkers });
                var tlTotal = tl.events.length;
                // 取页窗口（字节预算只收缩本页，不改变扫描面）
                var _tlOffset = timelinePaging.offset;
                if (_tlOffset > tlTotal) _tlOffset = tlTotal;
                var _tlStop = _tlOffset + timelinePaging.limit;
                if (_tlStop > tlTotal) _tlStop = tlTotal;
                // 嵌套合成只列不展开：先按条数上限切（真实条数看 timelineNestedTotal），
                // 再按字节预算收缩（字节计入同一份响应级预算）
                // timelineNestedOffset 先切片（默认 0），每页仍上限 100；
                // timelineNestedSkipped/Total 报的是真实 precomp 层数，不受本页起点影响。
                var _tlNestedAll = tl.nested;
                var _tlNestedOff = timelineNestedPaging.offset;
                if (_tlNestedOff > _tlNestedAll.length) _tlNestedOff = _tlNestedAll.length;
                var _tlNested = _tlNestedAll.slice(_tlNestedOff, _tlNestedOff + TIMELINE_NESTED_CAP);
                var _tlNestedCapHit = (_tlNestedOff + _tlNested.length) < _tlNestedAll.length;
                // 先落骨架（events/nestedLayers 空数组），把各 comp 的 timeline 字段本身也算进预算：
                // timeline 对象自身的元数据（scope/counts/total…）也是本响应的事件部分字节
                info.timeline = {
                    events: [],
                    // timelineTotal = 截断后可翻页总数（只受事件硬上限 5000 影响，**不受本页字节预算影响**，
                    // 所以逐页稳定）；timelineScannedTotal = 截断前真实条数（两者只在 timelineCapped=false 时相等）。
                    // 本页返回几条看 events.length，续页一律用 timelineNextOffset（本页起点 + 实际返回条数）。
                    timelineTotal: tlTotal,
                    timelineScannedTotal: tl.scannedTotal,
                    timelineOffset: _tlOffset,
                    timelineLimit: timelinePaging.limit,
                    timelineHasMore: _tlOffset < tlTotal,
                    // 续页偏移：本页起点 + 本页实际返回条数（字节预算收缩后仍不重不漏）
                    timelineNextOffset: _tlOffset,
                    // 实际扫到的属性族；未扫的族在 timelineUnscanned 里列出，不当"没有"
                    timelineScope: tl.scope,
                    // 按族计数：没有的族给 0（截断前计数，各族之和 = timelineScannedTotal）
                    timelineScopeCounts: tl.counts,
                    timelineUnscanned: ["effects", "shapeContents", "layerStyles", "cameraLight", "audioWaveform"],
                    // stretch≠100 的层不产关键帧事件（层本地时间→合成时间非线性）：列出其 layerIndex，
                    // 数组上限 100 条；总数（去重后的层数）看 timelineNonLinearSkippedTotal
                    timelineNonLinearSkipped: tl.nonLinearSkipped,
                    timelineNonLinearSkippedTotal: tl.nonLinearSkippedTotal,
                    // 嵌套合成只列不展开：数量在上，条目在 nestedLayers，下钻由调用方决定；
                    // nestedLayers 上限 100 条（timelineNestedTruncated=true 表示还有，
                    // 真实 precomp 层数看 timelineNestedTotal）
                    timelineNestedSkipped: tl.nested.length,
                    timelineNestedTotal: tl.nested.length,
                    // nestedLayers 分页：本页起点 + 下批起点（预算收缩后由下方按
                    // 实际返回条数改写；续读传 timelineNestedOffset=timelineNestedNextOffset）
                    timelineNestedOffset: _tlNestedOff,
                    timelineNestedNextOffset: _tlNestedOff,
                    nestedLayers: [],
                    // 事件总数超过硬上限 5000 时为 true（timelineTotal 是可翻页总数）
                    timelineCapped: tl.capped
                };
                // 元数据计费延后到 targets 循环之后（见下方「事件分配」）：边建边扣时，
                // 后面合成各自的 timeline 元数据会把总额顶出预算（5 合成实测 14,440B）。
                _tlPending.push({
                    info: info, tl: tl, tlTotal: tlTotal,
                    offset: _tlOffset, stop: _tlStop,
                    nested: _tlNested, nestedCapHit: _tlNestedCapHit,
                    // 本页 nestedLayers 起点（timelineNestedNextOffset = 起点 + 实际条数）
                    nestedOffset: _tlNestedOff,
                    // 目标序号：与 allComps 下标一致，供事件分配只给**本页**合成扣预算
                    order: ti
                });
            }
            if (wantRefs) {
                var refResult = _findSourceRefs(comp);
                info.references = refResult.refs;
                if (refResult.truncated) info.referencesTruncated = true;
            }
            allComps.push(info);
        }

        // 分页
        var totalCount = allComps.length;
        var startIdx = paging.offset;
        var endIdx = paging.offset + paging.limit;
        if (startIdx > totalCount) startIdx = totalCount;
        if (endIdx > totalCount) endIdx = totalCount;
        var paged = allComps.slice(startIdx, endIdx);

        // ── 事件分配：两阶段，先结算**本页**合成的 timeline 元数据，再按顺序
        // 把剩余额度分给 events 与 nestedLayers。这样做三件事：跨合成共享一份 12KB 预算；
        // events + nestedLayers + 各合成 timeline 字段的总额可控（单阶段边建边扣会被后续
        // 合成的元数据顶出预算）；只给本页合成扣预算（未返回的合成不占额度）。
        // 额度不足时收缩后续合成的 events 页（该合成置 timelineBytesTruncated；本页 0 条再置
        // timelineEventsStarved，改用单个 compositionId 续读）。
        var _tlMetaSum = 0;
        var _tlPageCompCount = 0;
        for (var _tmi = 0; _tmi < _tlPending.length; _tmi++) {
            if (_tlPending[_tmi].order < startIdx || _tlPending[_tmi].order >= endIdx) continue;
            var _tmBytes = 0;
            try { _tmBytes = JSON.stringify(_tlPending[_tmi].info.timeline).length; } catch (_) { _tmBytes = 0; }
            _tlMetaSum += (_tmBytes > 4 ? _tmBytes - 4 : 0);
            _tlPageCompCount++;
        }
        // 截断标记在计费之后才置位：timelineBytesTruncated /
        // timelineEventsStarved / timelineNestedTruncated 合计单条约 30–40B，5 合成实测事件部分
        // 12,253B。按页内每个合成预留 96B，使「事件部分 ≤12KB」在标记置位后仍成立。
        _tlRespBudget.used = _tlMetaSum + _tlPageCompCount * 96;
        for (var _tpj = 0; _tpj < _tlPending.length; _tpj++) {
            var _pend = _tlPending[_tpj];
            if (_pend.order < startIdx || _pend.order >= endIdx) continue;   // 不在本页：不扣额度、不置标记
            var _pendTl = _pend.tl;
            var _pendInfo = _pend.info;
            // 事件页：从剩余额度里取
            var _tlPage = [];
            var _tlBytes = 2;
            var _tlBytesTruncated = false;
            var _tlStarved = false;
            for (var _tei = _pend.offset; _tei < _pend.stop; _tei++) {
                var _teb = 0;
                try { _teb = JSON.stringify(_pendTl.events[_tei]).length; } catch (_) { _teb = 0; }
                var _teAdd = _teb + (_tlPage.length > 0 ? 1 : 0);
                if (_tlRespBudget.used + _tlBytes + _teAdd > TIMELINE_BYTE_BUDGET) {
                    _tlBytesTruncated = true;
                    if (_tlPage.length === 0) _tlStarved = true;
                    break;
                }
                _tlPage.push(_pendTl.events[_tei]);
                _tlBytes += _teAdd;
            }
            _tlRespBudget.used += _tlBytes;
            // 嵌套条目：同一份预算（300 precomp 层 × 多合成时 nestedLayers 是主要体量）
            var _tlNestedPage = [];
            var _tlNestedBytes = 2;
            var _tlNestedBytesTruncated = false;
            for (var _tni = 0; _tni < _pend.nested.length; _tni++) {
                var _tnb = 0;
                try { _tnb = JSON.stringify(_pend.nested[_tni]).length; } catch (_) { _tnb = 0; }
                var _tnAdd = _tnb + (_tlNestedPage.length > 0 ? 1 : 0);
                if (_tlRespBudget.used + _tlNestedBytes + _tnAdd > TIMELINE_BYTE_BUDGET) {
                    _tlNestedBytesTruncated = true;
                    break;
                }
                _tlNestedPage.push(_pend.nested[_tni]);
                _tlNestedBytes += _tnAdd;
            }
            _tlRespBudget.used += _tlNestedBytes;
            _pendInfo.timeline.events = _tlPage;
            _pendInfo.timeline.nestedLayers = _tlNestedPage;
            _pendInfo.timeline.timelineHasMore = (_pend.offset + _tlPage.length) < _pend.tlTotal;
            _pendInfo.timeline.timelineNextOffset = _pend.offset + _tlPage.length;
            // nestedLayers 的续读：timelineNestedOffset 已可消费，下一批起点 =
            // 本页起点 + 本页实际返回条数（字节预算收缩后仍不重不漏）；完整父子关系仍可用
            // queryProject(target=layers) 或 target=layer 的 tree。
            _pendInfo.timeline.timelineNestedNextOffset = _pend.nestedOffset + _tlNestedPage.length;
            if (_tlBytesTruncated || _tlNestedBytesTruncated) {
                _pendInfo.timeline.timelineBytesTruncated = true;
                _tlRespBudget.exhausted = true;
            }
            if (_tlStarved) _pendInfo.timeline.timelineEventsStarved = true;
            // offset>0 的页同样不是全集（与 masksTruncated 口径一致）
            if (_pend.nestedCapHit || _pend.nestedOffset > 0 || _tlNestedBytesTruncated) _pendInfo.timeline.timelineNestedTruncated = true;
        }

        var result = {
            status: "success",
            comps: paged, count: paged.length, totalCount: totalCount,
            itemOffset: paging.offset, itemLimit: paging.limit,
            hasMore: (paging.offset + paging.limit) < totalCount
        };
        // 事件部分响应级字节预算被触发（任一 comp 收缩 events 或 nestedLayers）
        if (_tlRespBudget.exhausted) result.timelineBytesTruncated = true;
        return result;
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

// 素材详情（支持批量）+ references
function getFootageInfo(args) {
    try {
        args = args || {};
        var wantRefs = args.references === true;
        var paging = _parsePaging({ offset: args.itemOffset, limit: args.itemLimit }, 5, 10);

        // 定位素材：稳定键 id（Item.id）优先于位置键索引——两者都给时以 id 为准（与
        // compositionId/compositionIndex 同一口径）。id 解析不到即**报错**，绝不退回索引：
        // 索引会随项目面板增删/重排移位，静默落到别的素材比报错更糟。
        // 批量语义：任一 id 失效即整批报错（不返回半批，与 queryDetails layer 的 layerIds 同款）。
        var targets = [];   // [{ item, idx }]，顺序即入参顺序
        var wantIds = null;
        if (args.footageIds !== undefined && args.footageIds !== null) {
            wantIds = args.footageIds;
        } else if (args.footageId !== undefined && args.footageId !== null) {
            // null = 未传（统一语义；footageId:null 若进 _resolveItemIds 会报错）
            wantIds = [args.footageId];
        }
        if (wantIds !== null) {
            var ftIdLabel = (args.footageIds !== undefined && args.footageIds !== null) ? "footageIds" : "footageId";
            // 形态/空数组/元素校验统一走 _resolveItemIds（公共 helper）：
            // 必须数组且非空；元素仅 number 或纯数字字符串的正整数，布尔/数组/对象/浮点报错点
            // 名第几项（Math.floor(Number(true)) → 1 会报"Footage id not found: 1"）。
            var _fidParsed = _resolveItemIds(wantIds, ftIdLabel);
            if (_fidParsed.error) return { status: "error", message: _fidParsed.error };
            for (var wi = 0; wi < _fidParsed.ids.length; wi++) {
                var wid = _fidParsed.ids[wi];
                var byId = _findItemById(wid);
                if (!(byId instanceof FootageItem)) {
                    return { status: "error", message: "Footage id not found (deleted?): " + wid };
                }
                targets.push({ item: byId, idx: _getItemIndex(byId) });
            }
        } else {
            var indices = [];
            if (args.footageIndices !== undefined && args.footageIndices !== null) {
                // 形态与值域校验：对字符串逐字符拆、越界/非素材
                // 条目 continue 静默丢掉（footageIndices:"12" 只回 1 条）。现在非数组报错，
                // 元素须是 1..numItems 的正整数且指向素材，任一无效即整批报错（对齐 footageIds）。
                if (!_isArrayValue(args.footageIndices)) return { status: "error", message: "footageIndices 需为数组" };
                if (args.footageIndices.length === 0) {
                    return { status: "error", message: "footageIndices 不能为空数组" };
                }
                for (var fix = 0; fix < args.footageIndices.length; fix++) {
                    var fiRaw = args.footageIndices[fix];
                    var fiVal = (typeof fiRaw === "number") ? fiRaw : NaN;
                    if (!isFinite(fiVal) || fiVal !== Math.floor(fiVal) || fiVal < 1) {
                        return { status: "error", message: "footageIndices 第 " + (fix + 1) + " 项不是正整数索引: " + String(fiRaw) };
                    }
                    if (fiVal > app.project.numItems) {
                        return { status: "error", message: "footageIndices 第 " + (fix + 1) + " 项越界: " + fiVal + "（项目条目数 " + app.project.numItems + "）" };
                    }
                    if (!(app.project.item(fiVal) instanceof FootageItem)) {
                        return { status: "error", message: "footageIndices 第 " + (fix + 1) + " 项不是素材: " + fiVal };
                    }
                    indices.push(fiVal);
                }
            } else if (args.footageIndex !== undefined && args.footageIndex !== null) {
                // 单值复用 footageIndices 的同一套校验：Number(...) + isNaN
                // 让 99/0/'abc' 之外的整数进入 indices，越界/非素材后 continue，最终
                // success/totalCount=0（数组同值整批报错）。
                var fiRawSingle = args.footageIndex;
                var fiSingle = (typeof fiRawSingle === "number") ? fiRawSingle : NaN;
                if (!isFinite(fiSingle) || fiSingle !== Math.floor(fiSingle) || fiSingle < 1) {
                    return { status: "error", message: "footageIndex 不是正整数索引: " + String(fiRawSingle) };
                }
                if (fiSingle > app.project.numItems) {
                    return { status: "error", message: "footageIndex 越界: " + fiSingle + "（项目条目数 " + app.project.numItems + "）" };
                }
                if (!(app.project.item(fiSingle) instanceof FootageItem)) {
                    return { status: "error", message: "footageIndex 不是素材: " + fiSingle };
                }
                indices.push(fiSingle);
            } else {
                return { status: "error", message: "需要 footageId/footageIds 或 footageIndex/footageIndices" };
            }
            for (var ii = 0; ii < indices.length; ii++) {
                var idx0 = indices[ii];
                if (idx0 < 1 || idx0 > app.project.numItems) continue;
                var item0 = app.project.item(idx0);
                if (!(item0 instanceof FootageItem)) continue;
                targets.push({ item: item0, idx: idx0 });
            }
        }

        var allFootage = [];
        for (var fi = 0; fi < targets.length; fi++) {
            var idx = targets[fi].idx;
            var item = targets[fi].item;

            // 类型判定
            var t = 'unknown';
            var mainSrc = null;
            try { mainSrc = item.mainSource; } catch (_) {}
            if (mainSrc) {
                if (mainSrc instanceof FileSource) {
                    var isStill = false;
                    try { isStill = !!mainSrc.isStill; } catch (_) {}
                    if (item.hasVideo && !isStill && item.frameRate > 0) t = 'video';
                    else if (item.hasAudio && !item.hasVideo) t = 'audio';
                    else if (isStill) t = 'image';
                    else t = 'footage';
                } else if (mainSrc instanceof PlaceholderSource) {
                    t = 'placeholder';
                } else if (typeof SolidSource !== "undefined" && mainSrc instanceof SolidSource) {
                    t = 'solid';
                }
            }

            var fp = '';
            try { if (mainSrc && mainSrc.file) fp = String(mainSrc.file.fsName); } catch (_) {}

            var info = {
                index: idx, id: _readItemId(item), name: item.name, type: t,
                duration: item.duration, width: item.width, height: item.height,
                frameRate: item.frameRate, hasVideo: item.hasVideo, hasAudio: item.hasAudio,
                filePath: fp
            };
            if (wantRefs) {
                var refResult = _findSourceRefs(item);
                info.references = refResult.refs;
                if (refResult.truncated) info.referencesTruncated = true;
            }
            allFootage.push(info);
        }

        var totalCount = allFootage.length;
        var startIdx = paging.offset;
        var endIdx = paging.offset + paging.limit;
        if (startIdx > totalCount) startIdx = totalCount;
        if (endIdx > totalCount) endIdx = totalCount;
        var paged = allFootage.slice(startIdx, endIdx);

        return {
            status: "success",
            footage: paged, count: paged.length, totalCount: totalCount,
            itemOffset: paging.offset, itemLimit: paging.limit,
            hasMore: (paging.offset + paging.limit) < totalCount
        };
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

// 搜索：comp/layer/expression
function searchProject(args) {
    try {
        args = args || {};
        var searchType = args.searchType || "";
        if (searchType !== "comp" && searchType !== "layer" && searchType !== "expression") {
            return { status: "error", message: "需要 searchType 参数（comp/layer/expression）" };
        }
        var name = args.name ? String(args.name).toLowerCase() : '';
        if (!name) return { status: "error", message: "需要 name 搜索关键字" };
        var layerTypeFilter = args.layerType ? String(args.layerType).toLowerCase() : '';
        var paging = _parsePaging({ offset: args.itemOffset, limit: args.itemLimit }, 30, 100);

        // 确定搜索范围（null = 未传，统一语义：null 不吞掉另一个键、也不缩小搜索范围）
        var comps = [];
        var _srchCompIdxGiven = (args.compositionIndex !== undefined && args.compositionIndex !== null)
            || (args.compIndex !== undefined && args.compIndex !== null);
        if (_srchCompIdxGiven) {
            var cIdx = (args.compositionIndex !== undefined && args.compositionIndex !== null)
                ? Number(args.compositionIndex) : Number(args.compIndex);
            if (cIdx >= 1 && cIdx <= app.project.numItems) {
                var c = app.project.item(cIdx);
                if (c instanceof CompItem) comps.push(c);
            }
        } else {
            for (var i = 1; i <= app.project.numItems; i++) {
                var item = app.project.item(i);
                if (item instanceof CompItem) comps.push(item);
            }
        }

        var results = [];

        if (searchType === "comp") {
            for (var ci = 0; ci < comps.length; ci++) {
                var comp = comps[ci];
                if (String(comp.name).toLowerCase().indexOf(name) >= 0) {
                    results.push({ compositionIndex: _getItemIndex(comp), name: comp.name });
                }
            }
        } else if (searchType === "layer") {
            for (var li = 0; li < comps.length; li++) {
                var comp = comps[li];
                for (var j = 1; j <= comp.numLayers; j++) {
                    var layer = comp.layer(j);
                    var lname = '';
                    try { lname = String(layer.name).toLowerCase(); } catch (_) {}
                    if (lname.indexOf(name) < 0) continue;
                    var lt = _getLayerType(layer);
                    if (layerTypeFilter && lt !== layerTypeFilter) continue;
                    results.push({ compositionIndex: _getItemIndex(comp), layerIndex: layer.index, name: layer.name, layerType: lt });
                }
            }
        } else if (searchType === "expression") {
            for (var ei = 0; ei < comps.length; ei++) {
                var comp = comps[ei];
                for (var j = 1; j <= comp.numLayers; j++) {
                    var layer = comp.layer(j);
                    _searchExpressions(layer, comp, name, results);
                }
            }
        } else {
            return { status: "error", message: "未知 searchType: " + searchType };
        }

        var totalCount = results.length;
        var startIdx = paging.offset;
        var endIdx = paging.offset + paging.limit;
        if (startIdx > totalCount) startIdx = totalCount;
        if (endIdx > totalCount) endIdx = totalCount;
        var paged = results.slice(startIdx, endIdx);

        return {
            status: "success",
            searchType: searchType,
            results: paged, count: paged.length, totalCount: totalCount,
            itemOffset: paging.offset, itemLimit: paging.limit,
            hasMore: (paging.offset + paging.limit) < totalCount
        };
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

// 递归搜索图层属性中的表达式
// 表达式全文可能很长（几百行 Elastic 等），返回时截断保护上下文（LLM 反馈）
var EXPR_MAX_LEN = 500;
function _searchExpressions(layer, comp, nameFilter, results) {
    function scanProp(prop) {
        try {
            if (prop.canSetExpression && prop.expression) {
                var expr = String(prop.expression).toLowerCase();
                if (expr.indexOf(nameFilter) >= 0) {
                    var full = String(prop.expression);
                    var shown = full;
                    var truncated = false;
                    if (full.length > EXPR_MAX_LEN) {
                        shown = full.slice(0, EXPR_MAX_LEN) + '…（已截断，全文 ' + full.length + ' 字符）';
                        truncated = true;
                    }
                    results.push({
                        compositionIndex: _getItemIndex(comp), layerIndex: layer.index,
                        propertyName: prop.name, expression: shown,
                        expressionTruncated: truncated, expressionLength: full.length
                    });
                }
            }
            if (prop.numProperties) {
                for (var i = 1; i <= prop.numProperties; i++) {
                    scanProp(prop.property(i));
                }
            }
        } catch (_) {}
    }
    try { scanProp(layer); } catch (_) {}
}

// 诊断：丢失素材 + 表达式错误
function getDiagnostics(args) {
    try {
        var missingFootage = [];
        var expressionErrors = [];

        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof FootageItem) {
                try {
                    var ms = item.mainSource;
                    // 官方 API：AVItem.footageMissing（占位符或源文件丢失均返回 true），
                    // FileSource.missingFootagePath 提供丢失路径；FileSource 无 missingFrame 属性
                    if (item.footageMissing) {
                        var fp = '';
                        try {
                            if (ms && ms instanceof FileSource) fp = String(ms.missingFootagePath || (ms.file ? ms.file.fsName : ''));
                            else if (ms && ms instanceof PlaceholderSource && ms.file) fp = String(ms.file.fsName);
                        } catch (_) {}
                        missingFootage.push({ footageIndex: i, name: item.name, filePath: fp });
                    }
                } catch (_) {}
            }
            if (item instanceof CompItem) {
                for (var j = 1; j <= item.numLayers; j++) {
                    var layer = item.layer(j);
                    _checkExpressionErrors(layer, item, expressionErrors);
                }
            }
        }

        return {
            status: "success",
            missingFootage: missingFootage,
            missingFootageCount: missingFootage.length,
            expressionErrors: expressionErrors,
            expressionErrorCount: expressionErrors.length
        };
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

// 递归检查属性表达式错误
function _checkExpressionErrors(layer, comp, errors) {
    function scanProp(prop) {
        try {
            if (prop.canSetExpression && prop.expression) {
                // 官方 API：Property.expressionError（非空字符串即表达式有错）
                var errText = "";
                try { errText = String(prop.expressionError || ""); } catch (_) {}
                if (errText) {
                    errors.push({
                        compositionIndex: _getItemIndex(comp), layerIndex: layer.index,
                        propertyName: prop.name, error: errText
                    });
                }
            }
            if (prop.numProperties) {
                for (var i = 1; i <= prop.numProperties; i++) {
                    scanProp(prop.property(i));
                }
            }
        } catch (_) {}
    }
    try { scanProp(layer); } catch (_) {}
}

// includeTree：为匹配图层构建在合成完整父子关系中的位置
function _buildLayerTreeForMatches(comp, matchedIndices) {
    // 构建 nodeMap
    var nodeMap = {};
    for (var i = 1; i <= comp.numLayers; i++) {
        var layer = comp.layer(i);
        var node = {
            name: layer.name, index: layer.index,
            layerType: _getLayerType(layer), parentIndex: 0, children: []
        };
        try { if (layer.parent) node.parentIndex = layer.parent.index; } catch (_) {}
        nodeMap[layer.index] = node;
    }
    // 构建树
    var allRoots = [];
    for (var idx = 1; idx <= comp.numLayers; idx++) {
        var n = nodeMap[idx];
        if (!n) continue;
        if (n.parentIndex && nodeMap[n.parentIndex]) {
            nodeMap[n.parentIndex].children.push(n);
        } else {
            allRoots.push(n);
        }
    }
    // 标记需要包含的节点：匹配的 + 祖先 + 后代
    var includeSet = {};
    for (var mi = 0; mi < matchedIndices.length; mi++) {
        var curIdx = matchedIndices[mi];
        var cur = nodeMap[curIdx];
        while (cur) {
            includeSet[curIdx] = true;
            if (cur.parentIndex && nodeMap[cur.parentIndex] && !includeSet[cur.parentIndex]) {
                curIdx = cur.parentIndex;
                cur = nodeMap[curIdx];
            } else { break; }
        }
    }
    function addDescendants(idx) {
        var node = nodeMap[idx];
        if (!node) return;
        for (var ci = 0; ci < node.children.length; ci++) {
            var childIdx = node.children[ci].index;
            if (!includeSet[childIdx]) { includeSet[childIdx] = true; addDescendants(childIdx); }
        }
    }
    for (var mi2 = 0; mi2 < matchedIndices.length; mi2++) addDescendants(matchedIndices[mi2]);
    // 剪枝
    function prune(nodes) {
        var result = [];
        for (var ni = 0; ni < nodes.length; ni++) {
            var node = nodes[ni];
            if (!includeSet[node.index]) continue;
            result.push({
                name: node.name, index: node.index, layerType: node.layerType,
                parentIndex: node.parentIndex, children: prune(node.children)
            });
        }
        return result;
    }
    return prune(allRoots);
}

// 选中对象概览（轻量，供 queryProject selected）
function getSelectedOverview(args) {
    try {
        args = args || {};
        var scope = args.scope || "";
        var paging = _parsePaging({ offset: args.itemOffset, limit: args.itemLimit }, 30, 100);

        if (scope === "project") {
            var items = [];
            var sel = app.project.selection;
            for (var i = 0; i < sel.length; i++) {
                var item = sel[i];
                var t = '';
                if (item instanceof FolderItem) t = 'folder';
                else if (item instanceof CompItem) t = 'comp';
                else if (item instanceof FootageItem) t = 'footage';
                // 稳定键随概览一起回传：面板「引用当前选中」在项目面板选中时按 Item.id 建引用
                //（索引与名字会随项目面板增删/重排/改名变化），id 读不到（旧版 AE）记 0，调用方据此拒建
                if (t) items.push({ index: _getItemIndex(item), id: _readItemId(item), name: item.name, type: t });
            }
            var total = items.length;
            var paged = items.slice(paging.offset, paging.offset + paging.limit);
            return { status: "success", scope: "project", items: paged, count: paged.length, totalCount: total, itemOffset: paging.offset, itemLimit: paging.limit, hasMore: (paging.offset + paging.limit) < total };
        } else if (scope === "timeline") {
            var comp = app.project.activeItem;
            if (!(comp instanceof CompItem)) return { status: "error", message: "无活动合成" };
            var layers = [];
            var selLayers = comp.selectedLayers;
            // 稳定键随概览一起回传：面板「引用当前选中图层」按 layerId/compositionId 建引用
            //（索引与名字会随增删/重排/改名变化），LLM 也据此在后续调用里按 id 定位。
            var _selCompId = _readItemId(comp);
            var _selCompName = '';
            try { _selCompName = String(comp.name); } catch (_) {}
            // comp 在整个选中循环里不变：索引循环外只算一次（每层算一次等于重复全工程扫描）
            var _selCompIndex = _getItemIndex(comp);
            // 内容摘要只对**返回页**计算（与 listLayers 同口径）：
            // 放分页前等于对全部选中层算 content + anim（每层合计约 90–110 次宿主调用），
            // 千层合成分页查 5 层也要算千份。totalCount 仍报总选中数。
            var total2 = selLayers.length;
            var _selStart = paging.offset;
            if (_selStart > total2) _selStart = total2;
            var _selEnd = _selStart + paging.limit;
            if (_selEnd > total2) _selEnd = total2;
            for (var j = _selStart; j < _selEnd; j++) {
                var layer = selLayers[j];
                var selEntry = { compositionIndex: _selCompIndex, layerIndex: layer.index, name: layer.name, layerType: _getLayerType(layer) };
                // 内容摘要：selected(timeline) 也带 content——按当前选中走模糊查询
                // 是主路径，拿不到摘要就会退回逐层 queryDetails（正是要避免的调用放大）。
                if (args.includeContent !== false) {
                    try { selEntry.content = _getLayerContentSummary(layer); } catch (_) {}
                    // 动画指纹：selected(timeline) 与 layers 同口径
                    try { selEntry.anim = _getLayerAnimSummary(layer); } catch (_) {}
                }
                var _selLayerId = _readLayerId(layer);
                if (_selLayerId > 0) selEntry.layerId = _selLayerId;
                if (_selCompId > 0) selEntry.compositionId = _selCompId;
                if (_selCompName) selEntry.compositionName = _selCompName;
                layers.push(selEntry);
            }
            // 单页字节预算：selected(timeline) 100 层 43,109 字符（默认 30 层约
            // 13KB 不越线）。与 queryProject(layers) 同一两级口径：先剥尾部条目的 content/anim
            // 载荷（contentOmitted=true，layerIndex/name 等身份保留——agent 上下文的
            // 「Selected layers:」只读身份，不会因此漏层），仍超预算才从尾部丢整条。
            // 任何一级收缩置 bytesTruncated=true；hasMore/nextItemOffset 按实际返回数前进。
            var PAGE_BYTE_BUDGET = 12000;
            var _selSizes = [];
            var _selBytes = 2;
            var _selTruncated = false;
            for (var _spi = 0; _spi < layers.length; _spi++) {
                var _spb = 0;
                try { _spb = JSON.stringify(layers[_spi]).length; } catch (_) { _spb = 0; }
                _selSizes[_spi] = _spb;
                _selBytes += _spb + (_spi > 0 ? 1 : 0);
            }
            if (_selBytes > PAGE_BYTE_BUDGET) {
                for (var _spsi = layers.length - 1; _spsi >= 0 && _selBytes > PAGE_BYTE_BUDGET; _spsi--) {
                    var _spEnt = layers[_spsi];
                    if (!_spEnt || (_spEnt.content === undefined && _spEnt.anim === undefined)) continue;
                    var _spBefore = _selSizes[_spsi];
                    try { delete _spEnt.content; delete _spEnt.anim; } catch (_) {}
                    _spEnt.contentOmitted = true;
                    var _spAfter = 0;
                    try { _spAfter = JSON.stringify(_spEnt).length; } catch (_) { _spAfter = _spBefore; }
                    _selBytes -= (_spBefore - _spAfter);
                    _selSizes[_spsi] = _spAfter;
                    _selTruncated = true;
                }
            }
            var _selKeep = layers.length;
            while (_selKeep > 1 && _selBytes > PAGE_BYTE_BUDGET) {
                _selKeep--;
                _selBytes -= (_selSizes[_selKeep] + 1);
                _selTruncated = true;
            }
            // 只剩 1 条仍超预算：如实标注（不再继续砍，砍成 0 会让 nextItemOffset 原地）
            if (_selBytes > PAGE_BYTE_BUDGET) _selTruncated = true;
            var _selPage = layers.slice(0, _selKeep);
            var _selNext = paging.offset + _selPage.length;
            var _selOvResult = {
                status: "success", scope: "timeline", items: _selPage, count: _selPage.length,
                totalCount: total2, itemOffset: paging.offset, itemLimit: paging.limit,
                hasMore: _selNext < total2, nextItemOffset: _selNext
            };
            if (_selTruncated) _selOvResult.bytesTruncated = true;
            return _selOvResult;
        }
        return { status: "error", message: "需要 scope 参数 (project 或 timeline)" };
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

// 选中对象详情（完整，供 queryDetails selected）
function getSelectedDetails(args) {
    try {
        args = args || {};
        // 内部参数隔离：本入口不消费任何 `_` 前缀内部参数（整页预算体由本函数
        // 自己建在 _selRespBudget），先整体剔除；工具入口 queryDetails 已先做过同一件事。
        var _selCleanArgs = {};
        for (var _scK in args) {
            if (!Object.prototype.hasOwnProperty.call(args, _scK)) continue;
            if (_scK.charAt(0) === "_") continue;
            _selCleanArgs[_scK] = args[_scK];
        }
        args = _selCleanArgs;
        var scope = args.scope || "";
        var paging = _parsePaging({ offset: args.itemOffset, limit: args.itemLimit }, 5, 10);
        // fields 组选择：只在 timeline（= 图层详情）分支有意义；项目面板条目没有分块，显式拒绝
        var wantFields = (args.fields !== undefined && args.fields !== null);

        if (scope === "project") {
            if (wantFields) {
                return { status: "error", message: "fields 不支持 selected(scope=project)：项目面板条目没有分块；图层请用 selected(scope=timeline) 或 target=layer" };
            }
            var items = [];
            var sel = app.project.selection;
            for (var i = 0; i < sel.length; i++) {
                var item = sel[i];
                if (item instanceof CompItem) {
                    items.push({ index: _getItemIndex(item), id: _readItemId(item), name: item.name, type: 'comp', width: item.width, height: item.height, duration: item.duration, frameRate: item.frameRate, numLayers: item.numLayers });
                } else if (item instanceof FootageItem) {
                    var fp = '';
                    try { if (item.mainSource && item.mainSource.file) fp = String(item.mainSource.file.fsName); } catch (_) {}
                    items.push({ index: _getItemIndex(item), id: _readItemId(item), name: item.name, type: 'footage', duration: item.duration, width: item.width, height: item.height, filePath: fp });
                } else if (item instanceof FolderItem) {
                    items.push({ index: _getItemIndex(item), id: _readItemId(item), name: item.name, type: 'folder', numItems: item.numItems });
                }
            }
            var total = items.length;
            var paged = items.slice(paging.offset, paging.offset + paging.limit);
            return { status: "success", scope: "project", items: paged, count: paged.length, totalCount: total, itemOffset: paging.offset, itemLimit: paging.limit, hasMore: (paging.offset + paging.limit) < total };
        } else if (scope === "timeline") {
            var comp = app.project.activeItem;
            if (!(comp instanceof CompItem)) return { status: "error", message: "无活动合成" };
            // fields 形态/合法性在入口校验一次：若靠页内第一次
            // getLayerInfo 报错，越界空页（itemOffset 超过选中数）或空选中没有对象可校验 →
            // fields:["nope"] 也返回 success。清单与文案和目标 layer 同一处（_parseFieldsArg）。
            var _selFieldsParsed = _parseFieldsArg(args.fields, "layer", "transform");
            if (!_selFieldsParsed.ok) return { status: "error", message: _selFieldsParsed.message };
            var selLayers = comp.selectedLayers;
            // 按选中页顺序构建单一数组：失败项在原位放占位记录。
            // 把失败项 push 到另一个数组、最后 concat 到末尾，页 [失败99, 2, 3] 变成
            // [2, 3, 失败99]，与 itemOffset 页序错位，调用方无法按位置对上选中顺序。
            var items = [];
            var failedCount = 0;
            // comp 在整个选中循环里不变：索引循环外只算一次（每层算一次最多重复 3 次扫描）
            var _selDetailCompIndex = _getItemIndex(comp);
            // 详情只对**返回页**提取（与 listLayers/getSelectedOverview 同口径）：
            // getLayerInfo 是最贵的一档（每层全量字段），默认 5/上限 10，分页前提取等于对全部选中层
            // 各取一次。totalCount 仍报总选中数；extractedCount/failedCount 是**页内**计数。
            var totalSelected = selLayers.length;
            var _selStart = paging.offset;
            if (_selStart > totalSelected) _selStart = totalSelected;
            var _selEnd = _selStart + paging.limit;
            if (_selEnd > totalSelected) _selEnd = totalSelected;
            // 响应级字节预算体：本页所有选中层共用一份（关键帧 12KB + 形状 12KB +
            // 蒙版/效果载荷 12KB），与 target=layer 的分页/预算口径一致——否则 10 层详情页会各自撑满 12KB
            var _selRespBudget = { kfUsed: 0, shapeUsed: 0, payloadUsed: 0, respUsed: 0, kfExhausted: false, shapeExhausted: false };
            for (var j = _selStart; j < _selEnd; j++) {
                // 图层身份逐层读一次（每层 1–2 次宿主读取，可接受）：fields 不含 base 时成功
                // 条目也要有 layerIndex/name/layerId，失败占位也要能定位（成功项只补
                // compositionIndex，两条成功项无法区分）。
                var _selLayer = selLayers[j];
                var _selLayerIndex = _selLayer.index;
                var _selLayerName = "";
                try { _selLayerName = String(_selLayer.name); } catch (_) { _selLayerName = ""; }
                var _selLayerId = _readLayerId(_selLayer);
                var _selLayerType = "";
                try { _selLayerType = _getLayerType(_selLayer); } catch (_) {}
                // 复用 getLayerInfo 逻辑获取完整详情
                var layerArgs = { compIndex: _selDetailCompIndex, layerIndex: _selLayerIndex };
                if (args.includeMaskVertices !== undefined) layerArgs.includeMaskVertices = args.includeMaskVertices;
                if (args.includeTextAnimators !== undefined) layerArgs.includeTextAnimators = args.includeTextAnimators;
                if (args.includeLayerStyles !== undefined) layerArgs.includeLayerStyles = args.includeLayerStyles;
                if (args.includeDisabledLayerStyleParams !== undefined) layerArgs.includeDisabledLayerStyleParams = args.includeDisabledLayerStyleParams;
                if (args.includeLayerStyleAnimation !== undefined) layerArgs.includeLayerStyleAnimation = args.includeLayerStyleAnimation;
                if (args.includeShapeContents !== undefined) layerArgs.includeShapeContents = args.includeShapeContents;
                if (args.includeShapeValues !== undefined) layerArgs.includeShapeValues = args.includeShapeValues;
                if (args.shapeNodeLimit !== undefined) layerArgs.shapeNodeLimit = args.shapeNodeLimit;
                // 效果动画索引：selected(timeline) 与 target=layer 同口径透传
                if (args.includeEffectAnimation !== undefined) layerArgs.includeEffectAnimation = args.includeEffectAnimation;
                // 关键帧窗口 + 响应级预算：selected(timeline) 与 target=layer 同口径；
                // 预算体整页共用一份（不是每层新建）
                if (args.keyframeOffset !== undefined) layerArgs.keyframeOffset = args.keyframeOffset;
                if (args.keyframeLimit !== undefined) layerArgs.keyframeLimit = args.keyframeLimit;
                // 逐属性 offset：selected(timeline) 同一口径透传
                if (args.keyframeOffsets !== undefined) layerArgs.keyframeOffsets = args.keyframeOffsets;
                // 蒙版/效果分页与顶点上限：selected(timeline) 与 target=layer 同口径透传
                if (args.maskOffset !== undefined) layerArgs.maskOffset = args.maskOffset;
                if (args.maskLimit !== undefined) layerArgs.maskLimit = args.maskLimit;
                if (args.effectOffset !== undefined) layerArgs.effectOffset = args.effectOffset;
                if (args.effectLimit !== undefined) layerArgs.effectLimit = args.effectLimit;
                // 文本动画器窗口：selected(timeline) 与 target=layer 同口径透传
                if (args.textAnimatorOffset !== undefined) layerArgs.textAnimatorOffset = args.textAnimatorOffset;
                if (args.textAnimatorLimit !== undefined) layerArgs.textAnimatorLimit = args.textAnimatorLimit;
                if (args.vertexLimit !== undefined) layerArgs.vertexLimit = args.vertexLimit;
                layerArgs._responseBudget = _selRespBudget;
                // fields 透传：selected(timeline) 与 target=layer 同一组 layer 块（入口已校验）
                if (args.fields !== undefined) layerArgs.fields = args.fields;
                var info = getLayerInfo(layerArgs);
                if (info.status === "success" && info.layers && info.layers.length > 0) {
                    var layerDetail = info.layers[0];
                    layerDetail.compositionIndex = _selDetailCompIndex;
                    // 图层身份恒带：fields 不含 base 时条目仍可定位、可区分（与选中页顺序对应）
                    layerDetail.layerIndex = _selLayerIndex;
                    if (layerDetail.name === undefined && _selLayerName) layerDetail.name = _selLayerName;
                    if (layerDetail.layerId === undefined && _selLayerId > 0) layerDetail.layerId = _selLayerId;
                    items.push(layerDetail);
                } else {
                    // 详情提取失败：原位占位（不静默丢弃、也不挪到页尾）
                    var _selPlaceholder = {
                        layerIndex: _selLayerIndex,
                        name: _selLayerName,
                        status: "error",
                        message: (info && info.message) || '详情提取失败',
                        compositionIndex: _selDetailCompIndex
                    };
                    if (_selLayerId > 0) _selPlaceholder.layerId = _selLayerId;
                    if (_selLayerType) _selPlaceholder.layerType = _selLayerType;
                    items.push(_selPlaceholder);
                    failedCount++;
                }
            }
            // totalCount 报告原始选中数（selLayers.length），而非成功条数——
            // 这样 LLM 能区分"无选中"与"选中存在但详情提取失败"
            var _selResultObj = {
                status: "success",
                scope: "timeline",
                items: items,
                count: items.length,
                totalCount: totalSelected,
                extractedCount: items.length - failedCount,
                failedCount: failedCount,
                itemOffset: paging.offset,
                itemLimit: paging.limit,
                hasMore: _selEnd < totalSelected
            };
            // 预算耗尽：与 target=layer 同一组结果级标记
            if (_selRespBudget.kfExhausted) _selResultObj.keyframesBudgetExhausted = true;
            if (_selRespBudget.shapeExhausted) _selResultObj.shapeBytesTruncated = true;
            if (_selRespBudget.payloadExhausted) _selResultObj.payloadBytesTruncated = true;
            // 未知 keyframeOffsets 键回显：与 target=layer 同名结果级字段。
            if (_isArrayValue(_selRespBudget.kfOffsetsIgnored) && _selRespBudget.kfOffsetsIgnored.length > 0) {
                _selResultObj.keyframeOffsetsIgnored = _selRespBudget.kfOffsetsIgnored;
            }
            // 响应级总预算：与 target=layer 同一兜底（载荷 → 形状 → 关键帧），
            // 固定字段（result 包装 + 每项 compositionIndex 等）按实际长度预留
            if (items.length > 0 && typeof _selRespBudget.enforceResponse === "function") {
                var _selWrapBytes = 0;
                try { _selWrapBytes = JSON.stringify(_selResultObj).length - JSON.stringify(items).length; } catch (_) { _selWrapBytes = 400; }
                if (!(_selWrapBytes > 0)) _selWrapBytes = 400;
                // warnings 由 queryDetails 包装层在本函数返回后追加：先按同一入口
                // 算出文案长度并入兜底额度，避免追加后把响应重新顶过 26000。
                try {
                    var _selWarns = _checkPagingArgs('selected', args);
                    if (_isArrayValue(_selWarns) && _selWarns.length > 0) {
                        _selWrapBytes += JSON.stringify(_selWarns).length + 14;   // ,"warnings": 包装
                    }
                } catch (_) {}
                if (_selRespBudget.enforceResponse(items, _selWrapBytes)) _selResultObj.responseBytesTruncated = true;
            }
            if (_selRespBudget.respExhausted) _selResultObj.responseBytesTruncated = true;
            for (var _srl = 0; _srl < items.length; _srl++) {
                if (items[_srl].keyframesBudgetExhausted) _selResultObj.keyframesBudgetExhausted = true;
                if (items[_srl].shapeBytesTruncated) _selResultObj.shapeBytesTruncated = true;
                if (items[_srl].payloadBytesTruncated) _selResultObj.payloadBytesTruncated = true;
                if (items[_srl].responseBytesTruncated) _selResultObj.responseBytesTruncated = true;
            }
            // 页内任一层 masks/effects 被预算饿死（0 条但总数 >0）→ 结果级
            // multiLayerPagination=true（与 target=layer 的层级同名字段同一语义）并给
            // starvedLayerIndexes。这些层按 nextMaskOffset 重试同一查询会原地拿 0 条，必须改用
            // 单层查询或 fields:['masks']/['effects']。兜底裁剪后才饿死的层同样计入。
            // textAnimators 饿死层同族一并计入。
            var _selStarvedIdx = [];
            for (var _ssi = 0; _ssi < items.length; _ssi++) {
                if (items[_ssi].masksStarved === true || items[_ssi].effectsStarved === true
                    || items[_ssi].textAnimatorsStarved === true) {
                    _selStarvedIdx.push(items[_ssi].layerIndex);
                }
            }
            if (_selStarvedIdx.length > 0) {
                _selResultObj.multiLayerPagination = true;
                _selResultObj.starvedLayerIndexes = _selStarvedIdx;
            }
            return _selResultObj;
        }
        return { status: "error", message: "需要 scope 参数 (project 或 timeline)" };
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

// ── 项目级动画总览（queryProject target=overview）─────────────
// 回答"哪些合成有动画、动到什么程度"，供选合成再下钻。分页按合成：itemOffset/itemLimit
// （默认 20，上限 50）；nameFilter 子串大小写不敏感；compositionIds 只统计指定合成；
// 单个合成走 _resolveStrictComp（与其它 target 同一口径：compositionId 优先，值须为 number 正整数）。
// 成本：返回页里每个合成扫全部图层（5 个变换属性 + Audio Levels + Time Remap + Source Text），只读
// numKeys/keyTime/表达式存在性，不读值、不读曲线；分页只减少每页合成数，单个合成仍是
// 全层扫描——大项目/多层合成可能慢，用 itemLimit 收窄。
// spanFrames 用合成帧：round((layer.startTime + keyTime) × comp.frameRate)。stretch≠100
// 的层跳过其关键帧（层时间与合成时间非线性，不猜换算），该合成置 spanNonLinear=true。
function getOverviewInfo(args) {
    try {
        args = args || {};
        var paging = _parsePaging({ offset: args.itemOffset, limit: args.itemLimit }, 20, 50);
        var nameFilter = args.nameFilter ? String(args.nameFilter).toLowerCase() : "";
        var targets = [];
        if (args.compositionIds !== undefined && args.compositionIds !== null) {
            // 形态/空数组/元素校验统一走 _resolveItemIds（与 queryDetails 的
            // layerIds/compositionIds/footageIds 同一份契约与文案）——裸调 _findItemById 时，
            // [] 返回 success/count=0（看起来像「没有合成」）、[922.9] floor 成 922 静默统计别的
            // 合成、[true] floor 成 1（若 id=1 存在则静默返回错合成）。
            var _ovidParsed = _resolveItemIds(args.compositionIds, "compositionIds");
            if (_ovidParsed.error) return { status: "error", message: _ovidParsed.error };
            var missingIds = [];
            for (var oi = 0; oi < _ovidParsed.ids.length; oi++) {
                var byId = _findItemById(_ovidParsed.ids[oi]);
                if (byId instanceof CompItem) targets.push(byId);
                else missingIds.push(String(_ovidParsed.ids[oi]));
            }
            if (missingIds.length > 0) {
                // 与 queryDetails 的 compositionIds 批量分支同一 label（不混用单数键名）
                return { status: "error", message: "compositionIds 找不到对应合成（可能已删除）: " + missingIds.join(", ") };
            }
        } else if ((args.compositionId !== undefined && args.compositionId !== null) ||
                   (args.compositionIndex !== undefined && args.compositionIndex !== null) ||
                   (args.compIndex !== undefined && args.compIndex !== null)) {
            // 单个合成：与 layers/layer/comp/effect 共用 _resolveStrictComp——值必须
            // number 正整数（类型/值域判断在 helper 内），不再静默忽略而返回全量合成
            var picked = _resolveStrictComp(args, false);
            if (picked.error) return { status: "error", message: picked.error };
            targets.push(picked.comp);
        } else {
            var projectItems = 0;
            try { projectItems = Number(app.project.numItems) || 0; } catch (_) { projectItems = 0; }
            for (var ii = 1; ii <= projectItems; ii++) {
                var item = null;
                try { item = app.project.item(ii); } catch (_) { continue; }
                if (item instanceof CompItem) targets.push(item);
            }
        }
        // nameFilter 在分页前过滤：totalCount 是过滤后的合成数，hasMore 据此判断
        if (nameFilter) {
            var kept = [];
            for (var ni = 0; ni < targets.length; ni++) {
                var compName = "";
                try { compName = String(targets[ni].name).toLowerCase(); } catch (_) { compName = ""; }
                if (compName.indexOf(nameFilter) >= 0) kept.push(targets[ni]);
            }
            targets = kept;
        }
        var totalCount = targets.length;
        var startIdx = paging.offset;
        var endIdx = paging.offset + paging.limit;
        if (startIdx > totalCount) startIdx = totalCount;
        if (endIdx > totalCount) endIdx = totalCount;
        var page = targets.slice(startIdx, endIdx);
        // 单属性扫描：只读 numKeys / keyTime / expression 存在性；first/last 是合成帧
        function ovPropStat(prop, fps, startTime, nonLinear) {
            var stat = { keys: 0, hasExpression: false, first: null, last: null };
            var n = 0;
            try { n = Number(prop.numKeys) || 0; } catch (_) { n = 0; }
            stat.keys = n;
            try {
                var expr = prop.expression;
                stat.hasExpression = (expr !== undefined && expr !== null && String(expr) !== "");
            } catch (_) { stat.hasExpression = false; }
            if (n > 0 && !nonLinear && fps > 0) {
                for (var ki = 1; ki <= n; ki++) {
                    var kt = 0;
                    try { kt = Number(prop.keyTime(ki)); } catch (_) { continue; }
                    var f = Math.round((startTime + kt) * fps);
                    if (!isFinite(f)) continue;
                    if (stat.first === null || f < stat.first) stat.first = f;
                    if (stat.last === null || f > stat.last) stat.last = f;
                }
            }
            return stat;
        }
        var transformNames = ["Position", "Scale", "Rotation", "Opacity", "Anchor Point", "Audio Levels"];
        var scopeFlags = { transform: false, timeRemap: false, sourceText: false };
        var comps = [];
        for (var ci = 0; ci < page.length; ci++) {
            var comp = page[ci];
            var fps = 0;
            try { fps = Number(comp.frameRate) || 0; } catch (_) { fps = 0; }
            var duration = 0;
            try { duration = Number(comp.duration) || 0; } catch (_) { duration = 0; }
            var numLayers = 0;
            try { numLayers = Number(comp.numLayers) || 0; } catch (_) { numLayers = 0; }
            var tracks = 0;
            var keyframes = 0;
            var expressions = 0;
            var animatedLayers = 0;
            var nestedLayers = 0;
            var firstFrame = null;
            var lastFrame = null;
            var spanNonLinear = false;
            var scannedTransform = false;
            var scannedTimeRemap = false;
            var scannedSourceText = false;
            for (var li = 1; li <= numLayers; li++) {
                var layer = null;
                try { layer = comp.layer(li); } catch (_) {}
                if (!layer) continue;
                var stretch = 100;
                try { stretch = Number(layer.stretch); } catch (_) { stretch = 100; }
                if (isNaN(stretch)) stretch = 100;
                var nonLinear = (stretch !== 100);
                if (nonLinear) spanNonLinear = true;
                var startTime = 0;
                try { startTime = Number(layer.startTime) || 0; } catch (_) { startTime = 0; }
                var layerAnimated = false;
                var stat = null;
                for (var tpi = 0; tpi < transformNames.length; tpi++) {
                    var tProp = null;
                    try { tProp = getPropSafe(layer, transformNames[tpi]); } catch (_) { tProp = null; }
                    if (!tProp) continue;
                    scannedTransform = true;
                    stat = ovPropStat(tProp, fps, startTime, nonLinear);
                    if (stat.keys > 0) { tracks++; keyframes += stat.keys; layerAnimated = true; }
                    if (stat.hasExpression) { expressions++; layerAnimated = true; }
                    if (stat.first !== null && (firstFrame === null || stat.first < firstFrame)) firstFrame = stat.first;
                    if (stat.last !== null && (lastFrame === null || stat.last > lastFrame)) lastFrame = stat.last;
                }
                // 时间重映射：仅 AVLayer 且已启用时属性存在
                try {
                    if (layer instanceof AVLayer && layer.timeRemapEnabled) {
                        var trProp = getPropSafe(layer, "Time Remap");
                        if (trProp) {
                            scannedTimeRemap = true;
                            stat = ovPropStat(trProp, fps, startTime, nonLinear);
                            if (stat.keys > 0) { tracks++; keyframes += stat.keys; layerAnimated = true; }
                            if (stat.hasExpression) { expressions++; layerAnimated = true; }
                            if (stat.first !== null && (firstFrame === null || stat.first < firstFrame)) firstFrame = stat.first;
                            if (stat.last !== null && (lastFrame === null || stat.last > lastFrame)) lastFrame = stat.last;
                        }
                    }
                } catch (_) {}
                // 文本层 Source Text：只读 numKeys/expression，不读文本内容
                try {
                    if (layer instanceof TextLayer) {
                        var textProps = layer.property("ADBE Text Properties");
                        var srcDoc = textProps ? textProps.property("ADBE Text Document") : null;
                        if (srcDoc) {
                            scannedSourceText = true;
                            stat = ovPropStat(srcDoc, fps, startTime, nonLinear);
                            if (stat.keys > 0) { tracks++; keyframes += stat.keys; layerAnimated = true; }
                            if (stat.hasExpression) { expressions++; layerAnimated = true; }
                            if (stat.first !== null && (firstFrame === null || stat.first < firstFrame)) firstFrame = stat.first;
                            if (stat.last !== null && (lastFrame === null || stat.last > lastFrame)) lastFrame = stat.last;
                        }
                    }
                } catch (_) {}
                // 嵌套合成：只数不展开（下钻由调用方决定）
                try {
                    if (layer instanceof AVLayer && layer.source instanceof CompItem) nestedLayers++;
                } catch (_) {}
                if (layerAnimated) animatedLayers++;
            }
            var entry = {
                compositionId: _readItemId(comp),
                name: "",
                width: null,
                height: null,
                frameRate: null,
                durationFrames: null,
                numLayers: numLayers,
                layerTypeCounts: _getLayerTypeCounts(comp),
                animatedLayers: animatedLayers,
                tracks: tracks,
                keyframes: keyframes,
                expressions: expressions,
                nestedLayers: nestedLayers,
                spanFrames: (firstFrame === null) ? null : { first: firstFrame, last: lastFrame }
            };
            try { entry.name = String(comp.name); } catch (_) {}
            try { entry.width = Number(comp.width); } catch (_) {}
            try { entry.height = Number(comp.height); } catch (_) {}
            if (fps > 0) {
                entry.frameRate = fps;
                entry.durationFrames = Math.round(duration * fps);
            }
            // stretch≠100 的层已跳过其关键帧：跨度假线标出来，不假装 spanFrames 就是全部
            if (spanNonLinear) entry.spanNonLinear = true;
            if (scannedTransform) scopeFlags.transform = true;
            if (scannedTimeRemap) scopeFlags.timeRemap = true;
            if (scannedSourceText) scopeFlags.sourceText = true;
            comps.push(entry);
        }
        // 实际扫到的族（页面内并集）；未扫的族固定明列，不按 0 计
        var scannedFamilies = [];
        if (scopeFlags.transform) scannedFamilies.push("transform");
        if (scopeFlags.timeRemap) scannedFamilies.push("timeRemap");
        if (scopeFlags.sourceText) scannedFamilies.push("sourceText");
        return {
            status: "success",
            comps: comps,
            count: comps.length,
            totalCount: totalCount,
            itemOffset: paging.offset,
            itemLimit: paging.limit,
            hasMore: (paging.offset + paging.limit) < totalCount,
            scanScope: scannedFamilies,
            unscanned: ["masks", "effects", "shapeContents", "textAnimatorParams", "layerStyles"]
        };
    } catch (e) {
        return { status: "error", message: e.toString() };
    }
}

// ── 合并查询聚合函数（供 queryProject/queryDetails/queryEnvironment 工具调用）──
// 根据 args.target 分派到对应函数
function queryProject(args) {
    if (!args || !args.target) return { status: "error", message: "缺少 target 参数" };
    var warnings = _checkPagingArgs(args.target, args);
    var result;
    switch (args.target) {
        case "browse": result = browseProject(args); break;
        case "layers": result = listLayers(args); break;
        case "renderQueue": result = getRenderQueueInfo(args); break;
        case "search": result = searchProject(args); break;
        case "selected": result = getSelectedOverview(args); break;
        case "active": result = getActiveCompInfo(args); break;
        // overview：项目级动画总览——每合成一行计数 + 关键帧跨度
        case "overview": result = getOverviewInfo(args); break;
        default: return { status: "error", message: "未知 target: " + args.target };
    }
    if (warnings.length > 0 && result && typeof result === 'object') {
        result.warnings = warnings;
    }
    return result;
}

function queryDetails(args) {
    if (!args || !args.target) return { status: "error", message: "缺少 target 参数" };
    // 内部参数隔离：`_` 前缀键是宿主内部接力通道（selected(timeline) 把整页
    // 共用的一份 _responseBudget 传给 getLayerInfo），不是工具参数。不剔除时 LLM 直接传
    // {_responseBudget:{respUsed:-999999}} 让 24000/12KB 两道门失效（实测 24000 总预算被绕过）。
    // 工具入口先剔除全部 `_` 前缀键，内部接力改由 getSelectedDetails 直接构造 args（不经这里）。
    if (args && typeof args === "object") {
        var _qdCleanArgs = {};
        for (var _qdK in args) {
            if (!Object.prototype.hasOwnProperty.call(args, _qdK)) continue;
            if (_qdK.charAt(0) === "_") continue;
            _qdCleanArgs[_qdK] = args[_qdK];
        }
        args = _qdCleanArgs;
    }
    // fields 只对分块的对象（comp/layer，以及 selected 的 timeline 分支）有意义；其它 target 显式拒绝，
    // 不静默忽略（调用方会以为缩小了结果面）。
    if (args.fields !== undefined && args.fields !== null &&
        args.target !== "comp" && args.target !== "layer" && args.target !== "selected") {
        return { status: "error", message: "fields 只支持 target=comp / layer / selected(scope=timeline)；" + args.target + " 没有分块" };
    }
    var warnings = _checkPagingArgs(args.target, args);
    var result;
    switch (args.target) {
        case "comp": result = getCompInfo(args); break;
        case "layer": result = getLayerInfo(args); break;
        case "footage": result = getFootageInfo(args); break;
        case "selected": result = getSelectedDetails(args); break;
        // effect：单个效果的内部状态（属性树/关键帧明细/表达式/指定时刻求值）。
        // 与 comp/layer/footage 同层——走详情查询一个入口，不另立工具（
        // ae-tools 重构计划的原始分派形态；叶子函数名不进工具面）。
        case "effect": result = getEffectInfo(args); break;
        default: return { status: "error", message: "未知 target: " + args.target };
    }
    if (warnings.length > 0 && result && typeof result === 'object') {
        result.warnings = warnings;
    }
    return result;
}

function queryEnvironment(args) {
    if (!args || !args.target) return { status: "error", message: "缺少 target 参数" };
    switch (args.target) {
        case "installPath": return getInstallPath(args);
        // availableEffects 由 bootstrap.js handler 层读缓存（app.effects 全量遍历会卡死 AE），不应到达 jsx 层
        case "availableEffects": return { status: "error", message: "availableEffects 查询由 handler 层缓存机制处理，不应到达 jsx 层" };
        case "diagnostics": return getDiagnostics(args);
        default: return { status: "error", message: "未知 target: " + args.target };
    }
}

// 加载完成标记：作为最后求值语句，evalScript 整个文件后 result === 'MCP_LOADED'，
// 供 ae-tools bootstrap / agent bridge 的注入校验使用（取代旧构建脚本拼接的探针）。
// 用三元而非裸 'MCP_LOADED' 字面量——同时校验 getProjectInfo 已定义，避免半加载误报 success。

// ============================================================================
// 显式导出块——本块是 jsx 闭包的**唯一对外契约面**。
// 导出顺序 = 原声明顺序（与文件内定义顺序一致，便于逐条审计）。
// 私有名单（不导出，共 20 项）：_isSensitivePath/_isSystemOrRootDir/_shortNameKey/_checkPath、
//   _getItemIndex/_getSourceKind/_castShadowVal/_rqStatusName/_autoOrientName/_getLayerType、
//   _findCompParents/_findSourceRefs/_getCompMarkers/_getLayerMarkers/_getLayerTypeCounts、
//   _buildLayerTreeForMatches、ADBE_MATCH、EXPR_MAX_LEN、
//   新增私有：_authFrame（帧本体，只经 __aeSAuth 门面委托）、_guard（安装状态）。
//   新增私有：_savedArtifactState（saveProject 的产物分档核查 helper——
//   保存能力对外只有参数式入口 saveProject，helper 不导出，防按名替换核查判据）。
// *** 新增顶层声明必须在此登记（漏登记 = 用户脚本库/面板按名调用断链；完备性测试兜底）。***
// ============================================================================
__aeSG.getActiveComp = getActiveComp;
__aeSG.getCompOrThrow = getCompOrThrow;
__aeSG.getPropSafe = getPropSafe;
__aeSG.getSubProp = getSubProp;
__aeSG.findEffectByName = findEffectByName;
__aeSG.getLayerTarget = getLayerTarget;
__aeSG.getProjectInfo = getProjectInfo;
__aeSG.getActiveCompInfo = getActiveCompInfo;
__aeSG.collectKeyframes = collectKeyframes;
__aeSG.listLayers = listLayers;
__aeSG._getSingleLayerDetail = _getSingleLayerDetail;
__aeSG._checkPagingArgs = _checkPagingArgs;
__aeSG.getLayerInfo = getLayerInfo;
__aeSG.createTextLayer = createTextLayer;
__aeSG.applyPreset = applyPreset;
__aeSG.__aeSAuth = {
    begin: function (token, payload) { return _authFrame.begin(token, payload); },
    end: function (token) { return _authFrame.end(token); },
    get: function () { return _authFrame.get(); }
};
__aeSG.__aeSGOn = __aeSGOn;
__aeSG.__aeSGDn = __aeSGDn;
__aeSG.executeExtendScript = executeExtendScript;
__aeSG.undoLastOperation = undoLastOperation;
__aeSG.saveProject = saveProject;
__aeSG.importFile = importFile;
__aeSG.replaceFootage = replaceFootage;
__aeSG.getEffectInfo = getEffectInfo;
__aeSG.getEffectsBatch = getEffectsBatch;
__aeSG.listFolderFiles = listFolderFiles;
__aeSG.getInstallPath = getInstallPath;
__aeSG.getPreviewFrame = getPreviewFrame;
// 参数式图片分析（analyzeImage 工具的宿主入口——文件模式只回元数据，
// 抓帧模式复用 getPreviewFrame 并把图片交给面板侧 vision hook 注入）
__aeSG.analyzeImage = analyzeImage;
__aeSG.openInViewer = openInViewer;
__aeSG.getRenderQueueInfo = getRenderQueueInfo;
// 参数式渲染（工具 renderComp 的宿主实现；路径校验在实现内，免 file 域）
__aeSG.renderComp = renderComp;
// 渲染前旧产物备份（bootstrap 模板通道在 __aeSGOn() 之前按名调用；
// 名字已登记 _INTERNAL_NAMES，授权代码按名引用会被拒）
__aeSG._backupRenderOutputs = _backupRenderOutputs;
__aeSG._blendModeName = _blendModeName;
__aeSG._parsePaging = _parsePaging;
__aeSG.browseProject = browseProject;
__aeSG.getCompInfo = getCompInfo;
__aeSG.getFootageInfo = getFootageInfo;
__aeSG.searchProject = searchProject;
__aeSG._searchExpressions = _searchExpressions;
__aeSG.getDiagnostics = getDiagnostics;
__aeSG._checkExpressionErrors = _checkExpressionErrors;
__aeSG.getSelectedOverview = getSelectedOverview;
__aeSG.getSelectedDetails = getSelectedDetails;
// 项目级动画总览（queryProject target=overview 的宿主入口）
__aeSG.getOverviewInfo = getOverviewInfo;
__aeSG.queryProject = queryProject;
__aeSG.queryDetails = queryDetails;
__aeSG.queryEnvironment = queryEnvironment;
})((typeof $ !== "undefined" && $.global) ? $.global : this);
(typeof getProjectInfo === "function" ? "MCP_LOADED" : "MCP_LOAD_FAILED");
