#include "AEConfig.h"
#include "AE_EffectVers.h"

#ifndef AE_OS_WIN
	#include "AE_General.r"
#endif

resource 'PiPL' (16000) {
	{	/* array properties */
		/* [1] */
		Kind {
			AEEffect
		},
		/* [2] */
		Name {
			"AS_Effect Host"
		},
		/* [3] */
		Category {
			"AS_ExtP"
		},
#ifdef AE_OS_WIN
	#ifdef AE_PROC_INTELx64
		CodeWin64X86 {"EffectMain"},
	#endif
#else
	#ifdef AE_OS_MAC
		CodeMacIntel64 {"EffectMain"},
		CodeMacARM64 {"EffectMain"},
	#endif
#endif
		/* [6] */
		AE_PiPL_Version {
			2,
			0
		},
		/* [7] */
		AE_Effect_Spec_Version {
			PF_PLUG_IN_VERSION,
			PF_PLUG_IN_SUBVERS
		},
		/* [8] */
		AE_Effect_Version {
			524288	/* PF_VERSION(1,0,0,0,0) = 0x80000，须与代码 GLOBAL_SETUP my_version 一致 */
		},
		/* [9] */
		AE_Effect_Info_Flags {
			0
		},
		/* [10] */
		AE_Effect_Global_OutFlags {
			0x6008406	/* WIDE_TIME_INPUT(0x2，@history 跨时间检出前 N 帧，须与 GLOBAL_SETUP 同步) | PIX_INDEPENDENT | DEEP_COLOR_AWARE | NON_PARAM_VARY | SEND_UPDATE_PARAMS_UI | CUSTOM_UI(0x8000) */
		},
		AE_Effect_Global_OutFlags_2 {
		0x200140E	/* PARAM_GROUP_START_COLLAPSED_FLAG(0x8) | FLOAT_COLOR_AWARE(0x1000) | SUPPORTS_SMART_RENDER(0x400) | SUPPORTS_GPU_RENDER_F32(0x2000000) | I_USE_3D_CAMERA(0x2) | I_USE_3D_LIGHTS(0x4，须与 GLOBAL_SETUP 同步) */
	},
		/* [11] */
		AE_Effect_Match_Name {
			"AS_Effect_Host"
		},
		/* [12] */
		AE_Reserved_Info {
			0
		},
		/* [13] */
		AE_Effect_Support_URL {
			"https://www.adobe.com"
		}
	}
};
