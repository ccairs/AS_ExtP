#include "AEConfig.h"

#ifndef AE_OS_WIN
	#include "AE_General.r"
#endif
resource 'PiPL' (16000) {
	{	/* array properties */
		/* [1] */
		Kind {
			AEGP
		},
		/* [2] */
		Name {
			"AS_Hotbox"
		},
		/* [3] */
		Category {
			"AS_ExtP"
		},
		/* [4] */
		Version {
			196608
		},
#ifdef AE_OS_WIN
		CodeWin64X86 {"EntryPointFunc"},
#else
	#ifdef AE_OS_MAC
		CodeMacIntel64 {"EntryPointFunc"},
		CodeMacARM64 {"EntryPointFunc"},
	#endif
#endif
	}
};
