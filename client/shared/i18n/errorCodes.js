// 错误码文案表：键 = 机器判据（AEFS Result code / reason、Bridge error code），
// 值 = 各语言文案。中文是源语言，其他语言缺失时回退中文（AEI18n.err 负责回退）。
(function (global) {
    'use strict';
    var CODES = {
        NOT_FOUND:        { 'zh-CN': '目标不存在',          'en-US': 'Not found',               'ja-JP': '対象が見つかりません', 'de-DE': 'Nicht gefunden', 'ko-KR': '찾을 수 없음', 'fr-FR': 'Introuvable', 'ru-RU': 'Не найдено' },
        CHANNEL_FAILURE:  { 'zh-CN': '通道不可用',          'en-US': 'Channel unavailable',     'ja-JP': 'チャネルが利用できません', 'de-DE': 'Kanal nicht verfügbar', 'ko-KR': '채널을 사용할 수 없음', 'fr-FR': 'Canal indisponible', 'ru-RU': 'Канал недоступен' },
        REJECTED:         { 'zh-CN': '操作被拒绝',          'en-US': 'Operation rejected',      'ja-JP': '操作が拒否されました', 'de-DE': 'Vorgang abgelehnt', 'ko-KR': '작업이 거부되었습니다', 'fr-FR': 'Opération refusée', 'ru-RU': 'Операция отклонена' },
        INVALID_PATH:     { 'zh-CN': '路径不合法',          'en-US': 'Invalid path',            'ja-JP': '無効なパス',          'de-DE': 'Ungültiger Pfad', 'ko-KR': '잘못된 경로', 'fr-FR': 'Chemin non valide', 'ru-RU': 'Недопустимый путь' },
        SYSTEM_DIR:       { 'zh-CN': '不允许操作系统目录',  'en-US': 'System directory is not allowed', 'ja-JP': 'システムディレクトリは使用できません', 'de-DE': 'Systemverzeichnis nicht erlaubt', 'ko-KR': '시스템 디렉터리는 사용할 수 없습니다', 'fr-FR': 'Répertoire système non autorisé', 'ru-RU': 'Системный каталог не разрешён' },
        SENSITIVE:        { 'zh-CN': '该路径受保护',        'en-US': 'Protected path',          'ja-JP': '保護されたパス',      'de-DE': 'Geschützter Pfad', 'ko-KR': '보호된 경로', 'fr-FR': 'Chemin protégé', 'ru-RU': 'Защищённый путь' },
        BODY_TOO_LARGE:   { 'zh-CN': '请求体超过上限（{max} 字节）', 'en-US': 'Request body exceeds limit ({max} bytes)', 'ja-JP': 'リクエスト本文が上限を超えています（{max} バイト）', 'de-DE': 'Anfrageinhalt überschreitet das Limit ({max} Byte)', 'ko-KR': '요청 본문이 한도를 초과했습니다({max}바이트)', 'fr-FR': 'Corps de requête trop volumineux ({max} octets)', 'ru-RU': 'Тело запроса превышает лимит ({max} байт)' },
        READ_FAILED:      { 'zh-CN': '读取失败',              'en-US': 'Read failed',             'ja-JP': '読み込みに失敗しました', 'de-DE': 'Lesen fehlgeschlagen', 'ko-KR': '읽기 실패', 'fr-FR': 'Échec de lecture', 'ru-RU': 'Ошибка чтения' },
        WRITE_FAILED:     { 'zh-CN': '写入失败',              'en-US': 'Write failed',            'ja-JP': '書き込みに失敗しました', 'de-DE': 'Schreiben fehlgeschlagen', 'ko-KR': '쓰기 실패', 'fr-FR': 'Échec d’écriture', 'ru-RU': 'Ошибка записи' },
        DELETE_FAILED:    { 'zh-CN': '删除失败',              'en-US': 'Delete failed',           'ja-JP': '削除に失敗しました', 'de-DE': 'Löschen fehlgeschlagen', 'ko-KR': '삭제 실패', 'fr-FR': 'Échec de suppression', 'ru-RU': 'Ошибка удаления' },
        DENIED:           { 'zh-CN': '拒绝访问',              'en-US': 'Access denied',           'ja-JP': 'アクセスが拒否されました', 'de-DE': 'Zugriff verweigert', 'ko-KR': '액세스가 거부되었습니다', 'fr-FR': 'Accès refusé', 'ru-RU': 'Доступ запрещён' },
        NO_CONTENT:       { 'zh-CN': '缺少内容',              'en-US': 'No content',              'ja-JP': '内容がありません',    'de-DE': 'Kein Inhalt', 'ko-KR': '내용이 없습니다', 'fr-FR': 'Aucun contenu', 'ru-RU': 'Нет содержимого' },
        DEPTH:            { 'zh-CN': '路径层级过浅，禁止该操作', 'en-US': 'Path is too shallow for this operation', 'ja-JP': 'パスの階層が浅すぎるため実行できません', 'de-DE': 'Pfad liegt zu weit oben für diesen Vorgang', 'ko-KR': '경로 깊이가 너무 얕아 이 작업을 실행할 수 없습니다', 'fr-FR': 'Chemin trop court pour cette opération', 'ru-RU': 'Слишком короткий путь для этой операции' },
        ENCODING_UNAVAILABLE: { 'zh-CN': '目标不是 UTF-8，按原编码写回不可用', 'en-US': 'Target is not UTF-8 and the original encoding cannot be written back', 'ja-JP': '対象が UTF-8 ではないため、元のエンコーディングで書き戻せません', 'de-DE': 'Ziel ist nicht UTF-8, ursprüngliche Kodierung nicht schreibbar', 'ko-KR': '대상이 UTF-8이 아니어서 원래 인코딩으로 되쓸 수 없습니다', 'fr-FR': 'La cible n’est pas en UTF-8 ; impossible de réécrire dans l’encodage d’origine', 'ru-RU': 'Цель не в UTF-8; перезапись в исходной кодировке невозможна' },
        BAD_REQUEST:      { 'zh-CN': '请求不合法',            'en-US': 'Bad request',             'ja-JP': '不正なリクエスト',    'de-DE': 'Ungültige Anfrage', 'ko-KR': '잘못된 요청', 'fr-FR': 'Requête invalide', 'ru-RU': 'Некорректный запрос' },
        METHOD_NOT_ALLOWED: { 'zh-CN': '请求方法不被支持',     'en-US': 'Method not allowed',      'ja-JP': '許可されていないメソッド', 'de-DE': 'Methode nicht erlaubt', 'ko-KR': '허용되지 않은 메서드', 'fr-FR': 'Méthode non autorisée', 'ru-RU': 'Метод не разрешён' },
        UNAUTHORIZED:     { 'zh-CN': '未授权',              'en-US': 'Unauthorized',            'ja-JP': '未認証',              'de-DE': 'Nicht autorisiert', 'ko-KR': '인증되지 않음', 'fr-FR': 'Non authentifié', 'ru-RU': 'Не авторизовано' },
        SERVER_ERROR:     { 'zh-CN': '服务内部错误',        'en-US': 'Internal server error',   'ja-JP': 'サーバー内部エラー',  'de-DE': 'Interner Serverfehler', 'ko-KR': '서버 내부 오류', 'fr-FR': 'Erreur interne du serveur', 'ru-RU': 'Внутренняя ошибка сервера' },
        UNKNOWN:          { 'zh-CN': '未知错误',            'en-US': 'Unknown error',           'ja-JP': '不明なエラー',        'de-DE': 'Unbekannter Fehler', 'ko-KR': '알 수 없는 오류', 'fr-FR': 'Erreur inconnue', 'ru-RU': 'Неизвестная ошибка' },
    };
    if (global) global.AE_I18N_ERROR_CODES = CODES;
    if (typeof module !== 'undefined' && module.exports) module.exports = CODES;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
