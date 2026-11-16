#pragma once
// smartRender.h —— SmartRender 回调（MFR 多帧渲染支持）
#include "AE_Effect.h"
#include "AE_EffectCB.h"

namespace host {

// SmartPreRender：检出输入层 + 设置输出请求
PF_Err smartPreRender(PF_InData* in_data, PF_OutData* out_data,
                      PF_ParamDef* params[], void* extra);

// SmartRender：检出输入像素 + GL 渲染 + 写回输出
PF_Err smartRender(PF_InData* in_data, PF_OutData* out_data,
                   PF_ParamDef* params[], void* extra);

} // namespace host
