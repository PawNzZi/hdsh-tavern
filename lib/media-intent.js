/**
 * 自然对话里的媒体意图判断。
 *
 * 三种模式：
 *  - off      只认模型显式输出的 <media_image> / <media_voice> 标签；
 *  - explicit 标签 + 用户明确说“发张图/来段语音”；
 *  - auto     再加：用户用自然语言表达想看/想听，或角色回复里叙述“发来一张照片/一段语音”。
 *
 * 只做保守判断，避免把“照片里那个人”之类的普通叙述误判成要生成图片。
 */

const IMAGE_EXPLICIT = /(发|来|给|拍|看|晒|传|整|换).{0,8}(图|照片|相片|自拍)|(看看|让我看看|给我看看).{0,5}(你|样子|照片|自拍)|你(现在|今天)?(长什么样|什么样|穿什么|在哪|在干嘛)|(拍|照).{0,4}(一张|张|个)?(照|相|图)|给我拍/;
const VOICE_EXPLICIT = /(发|来|给|录|听|整).{0,8}(语音|声音|音频)|(听|想听).{0,6}(你|声音|语音)|(说|念|唱).{0,6}(给我听|一句|首歌|句话)|打电话|语音通话/;
const IMAGE_AUTO = /(今天|现在).{0,4}(穿什么|在哪|在干嘛|什么样子)|(想|要)看.{0,4}(你|照片|自拍)|好想(看看)?你/;
const VOICE_AUTO = /(说句话|说句|唱首歌|打个电话|好想听|想听你)/;
const IMAGE_NARRATION = /(发来|发了|传来|附上|拍了|拍下|分享|甩来).{0,12}(照片|图片|自拍|相片)|[（(][^）)]{0,24}(照片|自拍|图片)[^）)]{0,12}[）)]|\[图片\]/;
const VOICE_NARRATION = /(发来|发了|传来|分享|甩来).{0,12}(语音|声音|音频)|[（(][^）)]{0,24}(语音|声音)[^）)]{0,12}[）)]|\[语音\]/;
const NEGATION = /(不要|别|不用|不想|无需|禁止|不许).{0,4}$/;
const IMAGE_PAST = /(你|他|她|它|角色)(发来|发的|发给|给的|拍的|分享的).{0,6}(照片|图片|自拍|相片)/;
const VOICE_PAST = /(你|他|她|它|角色)(发来|发的|发给|给的|录的|分享的).{0,6}(语音|声音|音频)/;

function matches(text, pattern) {
  const index = text.search(pattern);
  if (index < 0) return false;
  const before = text.slice(Math.max(0, index - 10), index);
  return !NEGATION.test(before);
}

/**
 * @param {{userText?: string, replyText?: string, mode?: string}} input
 * @returns {{image: boolean, voice: boolean, reasons: string[]}}
 */
export function detectMediaIntent(input = {}) {
  const user = typeof input.userText === 'string' ? input.userText : '';
  const reply = typeof input.replyText === 'string' ? input.replyText : '';
  const mode = input.mode === 'off' || input.mode === 'auto' ? input.mode : 'explicit';
  const reasons = [];
  if (mode === 'off') return { image: false, voice: false, reasons };
  const explicitImage = !IMAGE_PAST.test(user) && matches(user, IMAGE_EXPLICIT);
  const explicitVoice = !VOICE_PAST.test(user) && matches(user, VOICE_EXPLICIT);
  let image = explicitImage;
  let voice = explicitVoice;
  if (explicitImage) reasons.push('user-image');
  if (explicitVoice) reasons.push('user-voice');
  if (mode === 'auto') {
    if (!image && matches(user, IMAGE_AUTO)) {
      image = true;
      reasons.push('user-image-auto');
    }
    if (!voice && matches(user, VOICE_AUTO)) {
      voice = true;
      reasons.push('user-voice-auto');
    }
    if (!image && matches(reply, IMAGE_NARRATION)) {
      image = true;
      reasons.push('reply-image-narration');
    }
    if (!voice && matches(reply, VOICE_NARRATION)) {
      voice = true;
      reasons.push('reply-voice-narration');
    }
  }
  return { image, voice, reasons };
}
