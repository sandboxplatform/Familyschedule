/**
 * Words a shopping list is made of, for telling apart a list said in one
 * breath — "milk eggs bread coffee beans", which is how speech recognition
 * writes it, with no commas — from a single item that happens to be several
 * words.
 *
 * A run of words is split only when every word belongs to a known item, so
 * anything unfamiliar ("two pints of milk", "Grandma's birthday card") stays
 * whole. Multi-word items are listed so they win over their parts: "coffee
 * beans" is one thing, not coffee and beans.
 */

const SINGLES = `
milk eggs egg bread butter cheese yoghurt yogurt cream margarine
apples bananas oranges lemons limes grapes pears peaches plums nectarines
strawberries blueberries raspberries blackberries cherries berries melon
watermelon pineapple mango mangoes avocado avocados kiwi kiwis satsumas
clementines grapefruit rhubarb figs dates apricots raisins sultanas prunes
tomatoes potatoes onions garlic carrots celery lettuce spinach cucumber
peppers mushrooms broccoli cauliflower cabbage courgettes courgette zucchini
aubergine eggplant leeks peas beans corn sweetcorn ginger parsnips swede
turnips beetroot radishes asparagus kale rocket arugula herbs basil parsley
coriander cilantro mint thyme rosemary chillies chilies shallots squash
pumpkin
rice pasta spaghetti penne fusilli macaroni noodles flour sugar salt pepper
oil vinegar honey jam marmalade cereal oats porridge granola muesli cornflakes
lentils chickpeas quinoa couscous polenta
coffee tea teabags juice water wine beer cider lager gin vodka rum whisky
whiskey brandy prosecco champagne lemonade cola squash milkshake smoothies
chicken beef pork lamb mince bacon sausages ham turkey fish salmon tuna cod
haddock prawns shrimp mussels tofu steak burgers meatballs chorizo salami
pepperoni duck
chocolate biscuits cookies crisps chips crackers nuts popcorn cake sweets
candy pretzels doughnuts donuts brownies flapjacks
soup stock ketchup mayonnaise mayo mustard gravy yeast pesto hummus salsa
olives pickles gherkins capers relish chutney
bagels rolls croissants tortillas wraps pitta naan crumpets muffins
pancakes waffles baguette brioche scones
cheddar mozzarella parmesan feta brie halloumi stilton camembert
almonds walnuts peanuts cashews pistachios hazelnuts pecans coconut
batteries bulbs matches candles napkins foil clingfilm toothpaste shampoo
conditioner soap deodorant razors tissues nappies diapers wipes detergent
bleach sponges toothbrush toothbrushes floss sunscreen paracetamol ibuprofen
plasters bandaids lightbulbs
pizza lasagne lasagna quiche
`;

const PHRASES = `
coffee beans; ground coffee; instant coffee; coffee pods; tea bags; green tea;
herbal tea; peppermint tea
tin foil; aluminium foil; aluminum foil; cling film; kitchen roll; paper towels;
toilet roll; toilet paper; washing up liquid; dish soap; washing up sponges;
dishwasher tablets; dishwasher salt; rinse aid; washing powder; washing liquid;
laundry detergent; fabric softener; bin bags; bin liners; trash bags; garbage
bags; sandwich bags; freezer bags; zip lock bags; ziploc bags; baking paper;
parchment paper; light bulbs; aa batteries; aaa batteries
olive oil; vegetable oil; sunflower oil; coconut oil; rapeseed oil; sesame oil;
balsamic vinegar; white wine vinegar
orange juice; apple juice; cranberry juice; grape juice; pineapple juice;
lemon juice; lime juice; tomato juice
ice cream; sour cream; double cream; single cream; whipping cream; clotted
cream; cream cheese; cottage cheese; grated cheese; cheese slices; goats
cheese; blue cheese; cheese sauce
peanut butter; almond butter; almond milk; oat milk; soy milk; soya milk;
coconut milk; skimmed milk; semi skimmed milk; whole milk; chocolate milk;
greek yoghurt; greek yogurt; natural yoghurt; natural yogurt; fruit yoghurt;
strawberry yoghurt
brown bread; white bread; sliced bread; garlic bread; wholemeal bread; sourdough
bread; bread rolls; burger buns; hot dog buns; pizza bases
baked beans; green beans; kidney beans; black beans; butter beans; broad beans;
runner beans; bean sprouts; spring onions; green onions; red onions; sweet
potatoes; cherry tomatoes; chopped tomatoes; tinned tomatoes; canned tomatoes;
sun dried tomatoes; tomato sauce; tomato puree; tomato paste; tomato ketchup;
pasta sauce; soy sauce; hot sauce; bbq sauce; barbecue sauce; brown sauce;
sweet chilli sauce; worcestershire sauce; mint sauce; apple sauce; cranberry
sauce
red peppers; green peppers; yellow peppers; bell peppers; chilli peppers; salad
leaves; mixed salad; baby spinach; pak choi; bok choy; corn on the cob; frozen
peas; frozen sweetcorn; frozen berries; frozen vegetables; mixed vegetables;
fresh herbs; bay leaves
chicken breasts; chicken breast; chicken thighs; chicken wings; chicken
nuggets; whole chicken; chicken soup; chicken noodle soup; tomato soup;
vegetable soup; mushroom soup; ground beef; minced beef; beef mince; pork mince;
lamb mince; turkey mince; pork chops; lamb chops; pork belly; fish fingers; fish
sticks; fish cakes; hot dogs; smoked salmon; tuna steaks; salmon fillets; cod
fillets; frozen pizza; sausage rolls; scotch eggs
baking powder; baking soda; bicarbonate of soda; brown sugar; icing sugar;
caster sugar; plain flour; self raising flour; bread flour; maple syrup; golden
syrup; vanilla extract; dark chocolate; milk chocolate; white chocolate; hot
chocolate; chocolate chips; chocolate chip cookies; chocolate cake; carrot cake;
cereal bars; granola bars; protein bars; rice cakes; tortilla chips; potato
chips; cream crackers; digestive biscuits; ginger biscuits; mixed nuts; pine
nuts; trail mix
sparkling water; fizzy water; mineral water; tonic water; soda water; red wine;
white wine; rose wine; ginger beer; ginger ale; energy drinks; orange squash
dog food; cat food; cat litter; kitty litter; dog treats; cat treats; bird seed
hand soap; hand wash; shower gel; body wash; dental floss; cotton buds; cotton
wool; sun cream; lip balm; nail varnish remover; hair gel; face wipes; baby
wipes
chicken stock; beef stock; vegetable stock; stock cubes; gravy granules; corn
flakes; rice krispies; instant noodles; egg noodles; rice noodles; lasagne
sheets; pizza dough; puff pastry; shortcrust pastry; filo pastry; pie crust;
white rice; brown rice; basmati rice; jasmine rice; risotto rice; black pepper;
sea salt; garlic powder; onion powder; curry powder; chilli powder; mixed herbs;
strawberry jam; raspberry jam; apricot jam; lemon curd; orange marmalade
apple pie; mince pies; pork pie; meat pie; cottage pie; shepherds pie; fruit cake
salt and vinegar crisps; salt and vinegar chips; cheese and onion crisps; sour
cream and onion crisps; mac and cheese; macaroni and cheese; fish and chips;
salt and pepper; sweet and sour sauce; strawberries and cream; cookies and cream
`;

function stem(word) {
  const w = word.toLowerCase().replace(/[^a-z']/g, '').replace(/'s$/, 's');
  if (w.length <= 3) return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(?:ch|sh|x|ss|o)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

const key = (words) => words.map(stem).join(' ');

const singles = new Set(SINGLES.split(/\s+/).filter(Boolean).map(stem));
const phrases = new Set(
  PHRASES.split(/[;\n]/)
    .map((phrase) => phrase.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .map((phrase) => key(phrase.split(' '))),
);
const LONGEST = Math.max(...[...phrases].map((phrase) => phrase.split(' ').length));

/**
 * "milk eggs bread coffee beans" → ['milk', 'eggs', 'bread', 'coffee beans'].
 *
 * Returns the run split into known items, longest match first, or null when
 * any word belongs to no known item — in which case the run is better left as
 * it was said than guessed at.
 */
export function splitRunOn(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;

  const items = [];
  let i = 0;
  while (i < words.length) {
    let taken = 0;
    for (let length = Math.min(LONGEST, words.length - i); length >= 2; length -= 1) {
      if (phrases.has(key(words.slice(i, i + length)))) {
        taken = length;
        break;
      }
    }
    if (!taken && singles.has(stem(words[i]))) taken = 1;
    if (!taken) return null;
    items.push(words.slice(i, i + taken).join(' '));
    i += taken;
  }
  return items.length > 1 ? items : null;
}
