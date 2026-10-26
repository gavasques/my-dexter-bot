import type { SkillLockDto, SkillActivationDto, SetSkillActivation } from '@dexter/contracts';
/** Trusted owner administration only. Context implements this port; hub never imports Context. */
export interface HostSkillsPort {
  listSkills(query:{skillId?:string;after?:string;limit:number}):{items:SkillLockDto[];next:string|null};
  readSkill(id:string,version:string):{lock:SkillLockDto;markdown:string};
  registerSkill(id:string,version:string,markdown:string):SkillLockDto;
  listSkillActivations(query:{scopeKind:'global'|'bot';botId?:string;after?:string;limit:number}):{items:SkillActivationDto[];next:string|null};
  setSkillActivation(skillId:string,input:SetSkillActivation):SkillActivationDto;
  status():object;
}
