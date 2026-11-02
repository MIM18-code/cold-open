// First names with a strong conventional gender, for characters the action lines never describe plainly
// ("MAYA SANTOS (18) sits on the fence"). It is the weakest signal casting uses: a description, a role word or a
// clear pronoun majority overrides it. Names commonly given to anyone (Charlie, Sam, Alex, Jordan) are left out.
import type { Gender } from "./cast-ensemble.ts";

const FEMALE = `abby abigail ada adriana agnes aisha alexandra alice alicia alison allison alma amanda amber amelia amy ana
anastasia angela angelica angie anita ann anna annabelle anne annie antonia april ariana arlene ashley audrey ava
barbara beatrice becky belinda bella bernadette beth bethany betsy betty beverly bianca bonnie brenda brianna bridget brittany
brooke camila candace carla carmen carol caroline carolyn cassandra catherine cecilia celeste charlotte chelsea cheryl chloe
christina christine cindy claire clara claudia colleen connie constance crystal cynthia daisy daniela daphne darlene deborah
debra delia denise diana diane dolores donna doris dorothy edith edna eileen elaine eleanor elena elisa elizabeth ella ellen
eloise elsa emilia emily emma erica erika esperanza esther eva evelyn faith fatima felicia fiona florence frances francesca
gabriela gabriella gina gladys gloria grace greta gwen gwendolyn hailey hannah harriet hazel heather heidi helen helena hilda
holly ingrid irene iris isabel isabella isabelle ivy jacqueline jade jane janet janice jasmine jeanette jenna jennifer
jenny jessica jill joan joann joanna jocelyn josephine joy joyce juanita judith judy julia julie juliet june karen karina kate
katherine kathleen kathryn kathy katie kayla kimberly kristen kristin laura lauren leah leila lena lila lillian
lily linda lisa liz liza lois lorena lorraine louise lucia lucy luisa lydia mabel madeline madison maggie mallory marcia margaret
margarita maria mariah marian marie marilyn marina marisol marjorie marlene martha mary maureen maxine maya megan melanie melissa
mercedes mia michelle mildred miranda miriam molly monica nadia nancy naomi natalia natalie nicole nina nora norma olga olivia
paige pamela patricia paula pauline pearl peggy penelope penny phyllis priya rachel ramona rebecca regina renee rita roberta
rosa rosalie rosalind rose rosemary roxanne ruby ruth sabrina sadie samantha sandra sara sarah selena serena sharon sheila
shirley silvia sofia sonia sophia sophie stella stephanie susan suzanne sylvia tamara tanya tara teresa tessa
theresa tiffany tina valentina valerie vanessa vera veronica victoria violet virginia vivian wanda wendy whitney yolanda yvonne
zara zoe zoey`;

const MALE = `aaron abe abraham adam adrian ahmed alan albert alberto alejandro alfred alfredo allen alonzo alvin andre andres andrew
andy angelo anthony antonio archie arnold arthur arturo barry ben benjamin bernard bill billy bob bobby boris brad bradley brandon
brendan brett brian bruce bryan buck burt byron calvin carl carlos cecil cesar chad chester chuck clarence clark claude clifford
clint clyde colin cody conrad craig curtis dan daniel danny darnell darren dave david dean dennis derek desmond diego dmitri
dominic don donald doug douglas duane dwayne dwight earl eddie edgar eduardo edward edwin elijah elmer emilio emmanuel enrique
eric ernest ernesto ethan eugene evan felix fernando floyd francis francisco frank franklin fred freddie frederick gabe
gabriel gary gene geoffrey george gerald gilbert glen glenn gordon grant greg gregory gus hank harold harrison harry harvey hector
henry herbert herman homer horace howard hugh hugo ian igor isaac ivan jack jacob jake james jared jason javier jeff jeffrey
jeremy jerome jerry jesus jim jimmy joe joel joey john johnny jon jonathan jorge jose joseph josh joshua juan julian julio justin
karl keith ken kenneth kevin kurt kyle lance larry lawrence leo leon leonard leroy lester lewis liam lionel lloyd lorenzo louis
luis luke malcolm manuel marco marcus mario mark marshall martin marvin mateo matt matthew maurice max melvin michael miguel mike
miles milton mitch mitchell mohammed moses nathan nathaniel neil nelson nicholas nick nikolai noah norman oliver omar oscar otis
owen pablo patrick paul pedro perry pete peter phil philip phillip rafael ralph ramon randall randy raul ray raymond reggie
reginald ricardo richard rick ricky rob robert roberto rocco rodney roger roland roman ron ronald ronnie roy ruben rudy russell
ryan salvador samuel santiago scott sean sergei sergio seth shane shawn simon stan stanley stephen steve steven stuart ted
teddy terrence theodore thomas tim timothy toby todd tom tommy tony travis trevor troy tyler vernon victor vince vincent vladimir
wade wallace walter warren wayne wesley wilbur will william willie winston xavier zachary zack`;

const NAMES = new Map<string, Gender>([
 ...FEMALE.split(/\s+/).filter(Boolean).map((name) => [name, "female"] as const),
 ...MALE.split(/\s+/).filter(Boolean).map((name) => [name, "male"] as const),
]);

// Words that come before a first name in a cue without saying anything about gender.
const PREFIX = /^(?:YOUNG|OLD|OLDER|LITTLE|BIG|BABY|TEEN|ADULT|DR|DOCTOR|OFFICER|DETECTIVE|CAPTAIN|CAPT|COACH|PROFESSOR|PROF|SERGEANT|SGT|AGENT|DEPUTY|SHERIFF|PRINCIPAL|NURSE|JUDGE|REVEREND|FATHER-IN-LAW)$/;

/** The conventional gender of the first name in a cue ("YOUNG JERRY", "MAYA SANTOS"), when it has a strong one. */
export function nameGender(name: string, aliases: readonly string[] = []): Gender | undefined {
 for (const candidate of [name, ...aliases]) {
 const words = candidate.toUpperCase().replace(/['’]S\b/g, "").split(/[^A-Z-]+/).filter(Boolean);
 const first = words.find((word) => !PREFIX.test(word));
 const gender = first ? NAMES.get(first.toLowerCase()) : undefined;
 if (gender) return gender;
 }
 return undefined;
}
