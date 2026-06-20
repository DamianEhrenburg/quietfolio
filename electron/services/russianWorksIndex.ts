import { createHash } from "node:crypto";
import type { OnlineBookCandidate, ProviderReference } from "../../src/shared/types";
import type { InternalSettings } from "./settingsService";
import type { ResolvedSearchPlan } from "./queryResolver";

interface CuratedWork {
  ru: string;
  en?: string;
  de?: string;
  fr?: string;
  it?: string;
  es?: string;
  year?: number;
  coverIsbn?: string;
}

interface CuratedAuthor {
  displayName: string;
  aliases: string[];
  wikidataId?: string;
  category: string;
  works: CuratedWork[];
}

const CURATED_AUTHORS: CuratedAuthor[] = [
  {
    displayName: "Никколо Макиавелли",
    aliases: ["макиавелли", "никколо макиавелли", "niccolo machiavelli", "machiavelli", "niccolò machiavelli"],
    wikidataId: "Q7747",
    category: "Политика и общество",
    works: [
      { ru: "Государь", en: "The Prince", year: 1532 },
      { ru: "Рассуждения о первой декаде Тита Ливия", en: "Discourses on Livy", year: 1531 },
      { ru: "История Флоренции", en: "History of Florence", year: 1532 }
    ]
  },
  {
    displayName: "Иммануил Кант",
    aliases: ["иммануил кант", "кант", "immanuel kant", "kant"],
    wikidataId: "Q9312",
    category: "Философия",
    works: [
      { ru: "Критика чистого разума", en: "Critique of Pure Reason", de: "Kritik der reinen Vernunft", year: 1781 },
      { ru: "Критика практического разума", en: "Critique of Practical Reason", de: "Kritik der praktischen Vernunft", year: 1788 },
      { ru: "Критика способности суждения", en: "Critique of Judgment", de: "Kritik der Urteilskraft", year: 1790 },
      { ru: "Основы метафизики нравов", en: "Groundwork of the Metaphysics of Morals", de: "Grundlegung zur Metaphysik der Sitten", year: 1785 },
      { ru: "Пролегомены ко всякой будущей метафизике", en: "Prolegomena to Any Future Metaphysics", de: "Prolegomena zu einer jeden künftigen Metaphysik", year: 1783 },
      { ru: "Что такое Просвещение в отдельных людях", de: "Beantwortung der Frage: Was ist Aufklärung?", year: 1784 },
      { ru: "Метафизика нравов", en: "The Metaphysics of Morals", de: "Die Metaphysik der Sitten", year: 1797 },
      { ru: "Вечный мир", en: "Perpetual Peace", de: "Zum ewigen Frieden", year: 1795 }
    ]
  },
  {
    displayName: "Георг Вильгельм Фридрих Гегель",
    aliases: ["гегель", "г. в. ф. гегель", "georg wilhelm friedrich hegel", "hegel"],
    wikidataId: "Q9068",
    category: "Философия",
    works: [
      { ru: "Феноменология духа", en: "The Phenomenology of Spirit", de: "Phänomenologie des Geistes", year: 1807 },
      { ru: "Наука логики", en: "Science of Logic", de: "Wissenschaft der Logik", year: 1812 },
      { ru: "Философия права", en: "Elements of the Philosophy of Right", de: "Grundlinien der Philosophie des Rechts", year: 1820 },
      { ru: "Лекции по истории философии", en: "Lectures on the History of Philosophy", year: 1833 }
    ]
  },
  {
    displayName: "Фридрих Ницше",
    aliases: ["ницше", "фридрих ницше", "friedrich nietzsche", "nietzsche"],
    wikidataId: "Q9358",
    category: "Философия",
    works: [
      { ru: "Так говорил Заратустра", en: "Thus Spoke Zarathustra", de: "Also sprach Zarathustra", year: 1883 },
      { ru: "По ту сторону добра и зла", en: "Beyond Good and Evil", de: "Jenseits von Gut und Böse", year: 1886 },
      { ru: "Воля к власти", year: 1901 },
      { ru: "Генеалогия морали", en: "On the Genealogy of Morality", de: "Zur Genealogie der Moral", year: 1887 },
      { ru: "Рождение трагедии из духа музыки", en: "The Birth of Tragedy", de: "Die Geburt der Tragödie", year: 1872 },
      { ru: "Человеческое, слишком человеческое", en: "Human, All Too Human", year: 1878 },
      { ru: "Сумерки идолов", en: "Twilight of the Idols", de: "Götzen-Dämmerung", year: 1889 },
      { ru: "Антихрист", en: "The Antichrist", de: "Der Antichrist", year: 1895 },
      { ru: "Ecce homo", de: "Ecce homo", year: 1908 }
    ]
  },
  {
    displayName: "Платон",
    aliases: ["платон", "plato"],
    wikidataId: "Q859",
    category: "Философия",
    works: [
      { ru: "Государство", en: "Republic", year: -380 },
      { ru: "Пир", en: "Symposium", year: -385 },
      { ru: "Федон", en: "Phaedo", year: -385 },
      { ru: "Апология Сократа", en: "Apology", year: -399 },
      { ru: "Критон", en: "Crito", year: -399 },
      { ru: "Федр", en: "Phaedrus", year: -370 },
      { ru: "Тимей", en: "Timaeus", year: -360 }
    ]
  },
  {
    displayName: "Аристотель",
    aliases: ["аристотель", "aristotle"],
    wikidataId: "Q868",
    category: "Философия",
    works: [
      { ru: "Никомахова этика", en: "Nicomachean Ethics", year: -340 },
      { ru: "Политика", en: "Politics", year: -330 },
      { ru: "Метафизика", en: "Metaphysics", year: -330 },
      { ru: "Поэтика", en: "Poetics", year: -335 },
      { ru: "Риторика", en: "Rhetoric", year: -330 }
    ]
  },
  {
    displayName: "Рене Декарт",
    aliases: ["декарт", "рене декарт", "rene descartes", "descartes"],
    wikidataId: "Q9191",
    category: "Философия",
    works: [
      { ru: "Рассуждение о методе", en: "Discourse on the Method", fr: "Discours de la méthode", year: 1637 },
      { ru: "Медитации о первой философии", en: "Meditations on First Philosophy", year: 1641 },
      { ru: "Начала философии", en: "Principles of Philosophy", year: 1644 }
    ]
  },
  {
    displayName: "Артур Шопенгауэр",
    aliases: ["шопенгауэр", "arthur schopenhauer", "schopenhauer"],
    wikidataId: "Q38193",
    category: "Философия",
    works: [
      { ru: "Мир как воля и представление", en: "The World as Will and Representation", de: "Die Welt als Wille und Vorstellung", year: 1819 },
      { ru: "Афоризмы и максимы", en: "Aphorisms on the Wisdom of Life", year: 1851 }
    ]
  },
  {
    displayName: "Карл Маркс",
    aliases: ["маркс", "карл маркс", "karl marx", "marx"],
    wikidataId: "Q9061",
    category: "Философия",
    works: [
      { ru: "Капитал", de: "Das Kapital", year: 1867 },
      { ru: "Манифест коммунистической партии", en: "The Communist Manifesto", de: "Manifest der Kommunistischen Partei", year: 1848 },
      { ru: "Немецкая идеология", de: "Die deutsche Ideologie", year: 1932 },
      { ru: "Экономическо-философские рукописи 1844 года", year: 1932 }
    ]
  },
  {
    displayName: "Лев Толстой",
    aliases: ["толстой", "лев толстой", "leo tolstoy", "tolstoy"],
    wikidataId: "Q7243",
    category: "Художественная литература",
    works: [
      { ru: "Война и мир", en: "War and Peace", year: 1869, coverIsbn: "9781400079988" },
      { ru: "Анна Каренина", en: "Anna Karenina", year: 1877 },
      { ru: "Воскресение", en: "Resurrection", year: 1899 },
      { ru: "Смерть Ивана Ильича", en: "The Death of Ivan Ilyich", year: 1886 },
      { ru: "Казаки", year: 1863 },
      { ru: "Хаджи-Мурат", year: 1912 }
    ]
  },
  {
    displayName: "Фёдор Достоевский",
    aliases: ["достоевский", "федор достоевский", "фёдор достоевский", "dostoevsky", "fyodor dostoyevsky"],
    wikidataId: "Q991",
    category: "Художественная литература",
    works: [
      { ru: "Преступление и наказание", en: "Crime and Punishment", year: 1866, coverIsbn: "9780140449136" },
      { ru: "Идиот", en: "The Idiot", year: 1869, coverIsbn: "9780140447927" },
      { ru: "Братья Карамазовы", en: "The Brothers Karamazov", year: 1880 },
      { ru: "Бесы", en: "Demons", year: 1872 },
      { ru: "Записки из подполья", en: "Notes from Underground", year: 1864 },
      { ru: "Игрок", en: "The Gambler", year: 1866 }
    ]
  },
  {
    displayName: "Александр Пушкин",
    aliases: ["пушкин", "александр пушкин", "alexander pushkin", "pushkin"],
    wikidataId: "Q7200",
    category: "Художественная литература",
    works: [
      { ru: "Евгений Онегин", en: "Eugene Onegin", year: 1833 },
      { ru: "Капитанская дочка", en: "The Captain's Daughter", year: 1836, coverIsbn: "9781406894035" },
      { ru: "Медный всадник", year: 1833 },
      { ru: "Пиковая дама", en: "The Queen of Spades", year: 1834 },
      { ru: "Руслан и Людмила", year: 1820 },
      { ru: "Борис Годунов", year: 1825 }
    ]
  },
  {
    displayName: "Николай Гоголь",
    aliases: ["гоголь", "николай гоголь", "nikolai gogol", "gogol"],
    wikidataId: "Q43718",
    category: "Художественная литература",
    works: [
      { ru: "Мёртвые души", en: "Dead Souls", year: 1842, coverIsbn: "9780140448078" },
      { ru: "Ревизор", en: "The Government Inspector", year: 1836 },
      { ru: "Шинель", en: "The Overcoat", year: 1842 },
      { ru: "Вий", year: 1835 },
      { ru: "Тарас Бульба", year: 1835 }
    ]
  },
  {
    displayName: "Антон Чехов",
    aliases: ["чехов", "антон чехов", "anton chekhov", "chekhov"],
    wikidataId: "Q5685",
    category: "Художественная литература",
    works: [
      { ru: "Вишнёвый сад", en: "The Cherry Orchard", year: 1904 },
      { ru: "Чайка", en: "The Seagull", year: 1896 },
      { ru: "Три сестры", en: "Three Sisters", year: 1901 },
      { ru: "Дядя Ваня", en: "Uncle Vanya", year: 1897 },
      { ru: "Палата № 6", en: "Ward No. 6", year: 1892 },
      { ru: "История моей жизни", year: 1896 }
    ]
  },
  {
    displayName: "Михаил Булгаков",
    aliases: ["булгаков", "михаил булгаков", "mikhail bulgakov", "bulgakov"],
    wikidataId: "Q409",
    category: "Художественная литература",
    works: [
      { ru: "Мастер и Маргарита", en: "The Master and Margarita", year: 1967, coverIsbn: "9780141180144" },
      { ru: "Собачье сердце", en: "Heart of a Dog", year: 1925 },
      { ru: "Белая гвардия", year: 1925 },
      { ru: "Театральный роман", year: 1965 }
    ]
  },
  {
    displayName: "Олдос Хаксли",
    aliases: ["хаксли", "олдос хаксли", "aldous huxley", "huxley"],
    wikidataId: "Q81447",
    category: "Художественная литература",
    works: [
      { ru: "О дивный новый мир", en: "Brave New World", year: 1932, coverIsbn: "9780060850524" },
      { ru: "Остров", en: "Island", year: 1962 },
      { ru: "Контрапункт", en: "Point Counter Point", year: 1928 },
      { ru: "Двери восприятия", en: "The Doors of Perception", year: 1954 }
    ]
  },
  {
    displayName: "Джордж Оруэлл",
    aliases: ["оруэлл", "оруелл", "джордж оруэлл", "george orwell", "orwell"],
    wikidataId: "Q3335",
    category: "Художественная литература",
    works: [
      { ru: "1984", en: "Nineteen Eighty-Four", year: 1949, coverIsbn: "9780451524935" },
      { ru: "Скотный Двор", en: "Animal Farm", year: 1945, coverIsbn: "9780451526342" },
      { ru: "Дни в Бирме", en: "Burmese Days", year: 1934 },
      { ru: "Скотный двор", en: "Animal Farm", year: 1945, coverIsbn: "9780451526342" }
    ]
  },
  {
    displayName: "Энтони Бёрджесс",
    aliases: ["бёрджесс", "берджесс", "anthony burgess", "burgess"],
    wikidataId: "Q215045",
    category: "Художественная литература",
    works: [
      { ru: "Заводной апельсин", en: "A Clockwork Orange", year: 1962 },
      { ru: "Земляные силы", en: "Earthly Powers", year: 1980 }
    ]
  },
  {
    displayName: "Рэй Брэдбери",
    aliases: ["брэдбери", "бредбери", "ray bradbury", "bradbury"],
    wikidataId: "Q40640",
    category: "Научная фантастика",
    works: [
      { ru: "451 градус по Фаренгейту", en: "Fahrenheit 451", year: 1953, coverIsbn: "9781451673319" },
      { ru: "Вино из одуванчиков", en: "Dandelion Wine", year: 1957 },
      { ru: "Марсианские хроники", en: "The Martian Chronicles", year: 1950 },
      { ru: "И грянул гром", en: "A Sound of Thunder", year: 1952 }
    ]
  },
  {
    displayName: "Фрэнк Герберт",
    aliases: ["герберт", "фрэнк герберт", "frank herbert", "herbert"],
    wikidataId: "Q214642",
    category: "Научная фантастика",
    works: [
      { ru: "Дюна", en: "Dune", year: 1965, coverIsbn: "9780441172719" },
      { ru: "Мессия Дюны", en: "Dune Messiah", year: 1969 },
      { ru: "Дети Дюны", en: "Children of Dune", year: 1976 }
    ]
  },
  {
    displayName: "Дмитрий Глуховский",
    aliases: ["глуховский", "дмитрий глуховский", "dmitry glukhovsky", "glukhovsky"],
    wikidataId: "Q4168867",
    category: "Научная фантастика",
    works: [
      { ru: "Метро 2033", en: "Metro 2033", year: 2005, coverIsbn: "9780575086258" },
      { ru: "Метро 2034", en: "Metro 2034", year: 2009 },
      { ru: "Метро 2035", en: "Metro 2035", year: 2015 }
    ]
  },
  {
    displayName: "Айзек Азимов",
    aliases: ["азимов", "айзек азимов", "isaac asimov", "asimov"],
    wikidataId: "Q34981",
    category: "Научная фантастика",
    works: [
      { ru: "Основание", en: "Foundation", year: 1951 },
      { ru: "Я, робот", en: "I, Robot", year: 1950 },
      { ru: "Конец вечности", en: "The End of Eternity", year: 1955 },
      { ru: "Сами боги", en: "The Gods Themselves", year: 1972 }
    ]
  },
  {
    displayName: "Станислав Лем",
    aliases: ["лем", "станислав лем", "stanislaw lem", "lem"],
    wikidataId: "Q1296",
    category: "Научная фантастика",
    works: [
      { ru: "Солярис", en: "Solaris", year: 1961 },
      { ru: "Непобедимый", en: "The Invincible", year: 1964 },
      { ru: "Глас Господа", en: "His Master's Voice", year: 1968 },
      { ru: "Возвращение со звёзд", en: "Return from the Stars", year: 1961 }
    ]
  },
  {
    displayName: "Аркадий и Борис Стругацкие",
    aliases: ["стругацкие", "стругацкий", "strugatsky", "arkady strugatsky", "boris strugatsky"],
    wikidataId: "Q944134",
    category: "Научная фантастика",
    works: [
      { ru: "Пикник на обочине", en: "Roadside Picnic", year: 1972, coverIsbn: "9781613743416" },
      { ru: "Трудно быть богом", en: "Hard to Be a God", year: 1964 },
      { ru: "Понедельник начинается в субботу", year: 1965 },
      { ru: "Отблеск пожара", year: 1963 },
      { ru: "Град обречённый", year: 1989 }
    ]
  },
  {
    displayName: "Уильям Шекспир",
    aliases: ["шекспир", "william shakespeare", "shakespeare"],
    wikidataId: "Q692",
    category: "Драма",
    works: [
      { ru: "Гамлет", en: "Hamlet", year: 1603 },
      { ru: "Ромео и Джульетта", en: "Romeo and Juliet", year: 1597 },
      { ru: "Макбет", en: "Macbeth", year: 1623 },
      { ru: "Отелло", en: "Othello", year: 1604 },
      { ru: "Король Лир", en: "King Lear", year: 1608 },
      { ru: "Сон в летнюю ночь", en: "A Midsummer Night's Dream", year: 1600 }
    ]
  },
  {
    displayName: "Гомер",
    aliases: ["гомер", "homer"],
    wikidataId: "Q6691",
    category: "Классическая литература",
    works: [
      { ru: "Илиада", en: "Iliad", year: -750 },
      { ru: "Одиссея", en: "Odyssey", year: -700 }
    ]
  },
  {
    displayName: "Виктор Гюго",
    aliases: ["гюго", "виктор гюго", "victor hugo", "hugo"],
    wikidataId: "Q535",
    category: "Художественная литература",
    works: [
      { ru: "Отверженные", en: "Les Misérables", fr: "Les Misérables", year: 1862 },
      { ru: "Собор Парижской Богоматери", en: "The Hunchback of Notre-Dame", year: 1831 },
      { ru: "Человек, который смеётся", en: "The Man Who Laughs", year: 1869 }
    ]
  },
  {
    displayName: "Эрнест Хемингуэй",
    aliases: ["хемингуэй", "эрнест хемингуэй", "ernest hemingway", "hemingway"],
    wikidataId: "Q23434",
    category: "Художественная литература",
    works: [
      { ru: "Старик и море", en: "The Old Man and the Sea", year: 1952 },
      { ru: "Прощай, оружие!", en: "A Farewell to Arms", year: 1929 },
      { ru: "По ком звонит колокол", en: "For Whom the Bell Tolls", year: 1940 },
      { ru: "И восходит солнце", en: "The Sun Also Rises", year: 1926 }
    ]
  },
  {
    displayName: "Фрэнсис Скотт Фицджеральд",
    aliases: ["фицджеральд", "скотт фицджеральд", "f. scott fitzgerald", "fitzgerald", "scott fitzgerald"],
    wikidataId: "Q93354",
    category: "Художественная литература",
    works: [
      { ru: "Великий Гэтсби", en: "The Great Gatsby", year: 1925, coverIsbn: "9780743273565" },
      { ru: "Прекрасные и проклятые", en: "The Beautiful and Damned", year: 1922 },
      { ru: "Ночь нежна", en: "Tender Is the Night", year: 1934 }
    ]
  },
  {
    displayName: "Харпер Ли",
    aliases: ["харпер ли", "ли харпер", "harper lee", "lee"],
    wikidataId: "Q103659",
    category: "Художественная литература",
    works: [
      { ru: "Убить пересмешника", en: "To Kill a Mockingbird", year: 1960, coverIsbn: "9780061120084" },
      { ru: "Пойди поставь сторожа", en: "Go Set a Watchman", year: 2015 }
    ]
  },
  {
    displayName: "Джером Дэвид Сэлинджер",
    aliases: ["сэлинджер", "джером сэлинджер", "j. d. salinger", "jd salinger", "salinger"],
    wikidataId: "Q5878",
    category: "Художественная литература",
    works: [
      { ru: "Над пропастью во ржи", en: "The Catcher in the Rye", year: 1951, coverIsbn: "9780316769488" },
      { ru: "Девять рассказов", en: "Nine Stories", year: 1953 }
    ]
  },
  {
    displayName: "Франц Кафка",
    aliases: ["кафка", "франц кафка", "franz kafka", "kafka"],
    wikidataId: "Q905",
    category: "Художественная литература",
    works: [
      { ru: "Процесс", en: "The Trial", de: "Der Prozess", year: 1925 },
      { ru: "Замок", en: "The Castle", de: "Das Schloss", year: 1926 },
      { ru: "Превращение", en: "The Metamorphosis", de: "Die Verwandlung", year: 1915 },
      { ru: "Америка", en: "Amerika", de: "Der Verschollene", year: 1927 }
    ]
  },
  {
    displayName: "Альбер Камю",
    aliases: ["камю", "альбер камю", "albert camus", "camus"],
    wikidataId: "Q34670",
    category: "Художественная литература",
    works: [
      { ru: "Чума", en: "The Plague", fr: "La Peste", year: 1947 },
      { ru: "Посторонний", en: "The Stranger", fr: "L'Étranger", year: 1942 },
      { ru: "Падение", en: "The Fall", fr: "La Chute", year: 1956 }
    ]
  },
  {
    displayName: "Эрих Мария Ремарк",
    aliases: ["ремарк", "эрих мария ремарк", "erich maria remarque", "remarque"],
    wikidataId: "Q4617",
    category: "Художественная литература",
    works: [
      { ru: "На Западном фронте без перемен", en: "All Quiet on the Western Front", de: "Im Westen nichts Neues", year: 1929 },
      { ru: "Три товарища", en: "Three Comrades", de: "Drei Kameraden", year: 1936 },
      { ru: "Чёрный обелиск", en: "The Black Obelisk", de: "Der schwarze Obelisk", year: 1956 }
    ]
  },
  {
    displayName: "Антуан де Сент-Экзюпери",
    aliases: ["сент-экзюпери", "экзюпери", "antoine de saint-exupery", "saint-exupery", "saint-exupéry"],
    wikidataId: "Q2908",
    category: "Художественная литература",
    works: [
      { ru: "Маленький принц", en: "The Little Prince", fr: "Le Petit Prince", year: 1943 },
      { ru: "Ночной полёт", en: "Night Flight", fr: "Vol de nuit", year: 1931 }
    ]
  },
  {
    displayName: "Курт Воннегут",
    aliases: ["воннегут", "курт воннегут", "kurt vonnegut", "vonnegut"],
    wikidataId: "Q49074",
    category: "Научная фантастика",
    works: [
      { ru: "Бойня номер пять", en: "Slaughterhouse-Five", year: 1969 },
      { ru: "Сирены Титана", en: "The Sirens of Titan", year: 1959 },
      { ru: "Колыбель для кошки", en: "Cat's Cradle", year: 1963 }
    ]
  },
  {
    displayName: "Говард Филлипс Лавкрафт",
    aliases: ["лавкрафт", "говард лавкрафт", "howard lovecraft", "lovecraft", "h p lovecraft", "hp lovecraft"],
    wikidataId: "Q169566",
    category: "Ужасы и мистика",
    works: [
      { ru: "Зов Ктулху", en: "The Call of Cthulhu", year: 1928 },
      { ru: "Тень над Инсмутом", en: "The Shadow over Innsmouth", year: 1936 },
      { ru: "На горе безумия", en: "At the Mountains of Madness", year: 1936 },
      { ru: "Свет за пределами времени", en: "The Colour Out of Space", year: 1927 },
      { ru: "Храм", en: "The Temple", year: 1925 }
    ]
  },
  {
    displayName: "Джон Рональд Руэл Толкин",
    aliases: ["толкин", "джон толкин", "j r r tolkien", "jrr tolkien", "tolkien"],
    wikidataId: "Q892",
    category: "Фэнтези",
    works: [
      { ru: "Властелин колец", en: "The Lord of the Rings", year: 1954, coverIsbn: "9780618640157" },
      { ru: "Хоббит", en: "The Hobbit", year: 1937, coverIsbn: "9780547928227" },
      { ru: "Сильмариллион", en: "The Silmarillion", year: 1977 }
    ]
  },
  {
    displayName: "Эдгар Аллан По",
    aliases: ["по", "эдгар по", "edgar allan poe", "edgar poe", "poe"],
    wikidataId: "Q16867",
    category: "Ужасы и мистика",
    works: [
      { ru: "Ворон", en: "The Raven", year: 1845 },
      { ru: "Падение дома Ашеров", en: "The Fall of the House of Usher", year: 1839 },
      { ru: "Убийство на улице Морг", en: "The Murders in the Rue Morgue", year: 1841 },
      { ru: "Сердце-обличитель", en: "The Tell-Tale Heart", year: 1843 }
    ]
  },
  {
    displayName: "Герберт Уэллс",
    aliases: ["уэллс", "герберт уэллс", "h g wells", "hg wells", "wells"],
    wikidataId: "Q9047",
    category: "Научная фантастика",
    works: [
      { ru: "Война миров", en: "The War of the Worlds", year: 1898 },
      { ru: "Машина времени", en: "The Time Machine", year: 1895 },
      { ru: "Человек-невидимка", en: "The Invisible Man", year: 1897 },
      { ru: "Остров доктора Моро", en: "The Island of Doctor Moreau", year: 1896 }
    ]
  },
  {
    displayName: "Жюль Верн",
    aliases: ["верн", "жюль верн", "jules verne", "verne"],
    wikidataId: "Q142",
    category: "Научная фантастика",
    works: [
      { ru: "Двадцать тысяч льёг под водой", en: "Twenty Thousand Leagues Under the Seas", fr: "Vingt mille lieues sous les mers", year: 1870 },
      { ru: "Вокруг света за 80 дней", en: "Around the World in Eighty Days", fr: "Le Tour du monde en quatre-vingts jours", year: 1872 },
      { ru: "Таинственный остров", en: "The Mysterious Island", fr: "L'Île mystérieuse", year: 1874 },
      { ru: "Путешествие к центру Земли", en: "Journey to the Center of the Earth", fr: "Voyage au centre de la Terre", year: 1864 }
    ]
  },
  {
    displayName: "Роберт Льюис Стивенсон",
    aliases: ["стивенсон", "роберт стивенсон", "robert louis stevenson", "stevenson"],
    wikidataId: "Q1512",
    category: "Художественная литература",
    works: [
      { ru: "Остров сокровищ", en: "Treasure Island", year: 1883 },
      { ru: "Странная история доктора Джекила и мистера Хайда", en: "Strange Case of Dr Jekyll and Mr Hyde", year: 1886 },
      { ru: "Похищенный", en: "Kidnapped", year: 1886 }
    ]
  },
  {
    displayName: "Герман Мелвилл",
    aliases: ["мелвилл", "герман мелвилл", "herman melville", "melville"],
    wikidataId: "Q4985",
    category: "Художественная литература",
    works: [
      { ru: "Моби Дик", en: "Moby-Dick", year: 1851, coverIsbn: "9781503280786" },
      { ru: "Билли Бадд", en: "Billy Budd", year: 1924 }
    ]
  },
  {
    displayName: "Джеймс Джойс",
    aliases: ["джойс", "джеймс джойс", "james joyce", "joyce"],
    wikidataId: "Q6882",
    category: "Художественная литература",
    works: [
      { ru: "Улисс", en: "Ulysses", year: 1922 },
      { ru: "Дублинцы", en: "Dubliners", year: 1914 },
      { ru: "Портрет художника в юности", en: "A Portrait of the Artist as a Young Man", year: 1916 }
    ]
  },
  {
    displayName: "Артур Конан Дойл",
    aliases: ["конан дойл", "дойл", "arthur conan doyle", "conan doyle", "doyle"],
    wikidataId: "Q35610",
    category: "Детектив",
    works: [
      { ru: "Этюд в багровых тонах", en: "A Study in Scarlet", year: 1887 },
      { ru: "Собака Баскервилей", en: "The Hound of the Baskervilles", year: 1902 },
      { ru: "Знак четырёх", en: "The Sign of the Four", year: 1890 }
    ]
  },
  {
    displayName: "Мэри Шелли",
    aliases: ["шелли", "мэри шелли", "mary shelley", "shelley"],
    wikidataId: "Q47152",
    category: "Ужасы и мистика",
    works: [
      { ru: "Франкенштейн", en: "Frankenstein", year: 1818 }
    ]
  },
  {
    displayName: "Оскар Уайльд",
    aliases: ["уайльд", "оскар уайльд", "oscar wilde", "wilde"],
    wikidataId: "Q30875",
    category: "Художественная литература",
    works: [
      { ru: "Портрет Дориана Грея", en: "The Picture of Dorian Gray", year: 1890 },
      { ru: "Как важно быть серьёзным", en: "The Importance of Being Earnest", year: 1895 }
    ]
  },
  {
    displayName: "Марк Твен",
    aliases: ["твен", "марк твен", "mark twain", "twain"],
    wikidataId: "Q7245",
    category: "Художественная литература",
    works: [
      { ru: "Приключения Тома Сойера", en: "The Adventures of Tom Sawyer", year: 1876 },
      { ru: "Приключения Гекльберри Финна", en: "Adventures of Huckleberry Finn", year: 1884 },
      { ru: "Янки при дворе короля Артура", en: "A Connecticut Yankee in King Arthur's Court", year: 1889 }
    ]
  },
  {
    displayName: "Чарльз Диккенс",
    aliases: ["диккенс", "чарльз диккенс", "charles dickens", "dickens"],
    wikidataId: "Q5686",
    category: "Художественная литература",
    works: [
      { ru: "Оливер Твист", en: "Oliver Twist", year: 1838 },
      { ru: "Большие надежды", en: "Great Expectations", year: 1861 },
      { ru: "Холодный дом", en: "Bleak House", year: 1853 },
      { ru: "Повесть о двух городах", en: "A Tale of Two Cities", year: 1859 }
    ]
  },
  {
    displayName: "Джейн Остин",
    aliases: ["остин", "джейн остин", "jane austen", "austen"],
    wikidataId: "Q36322",
    category: "Художественная литература",
    works: [
      { ru: "Гордость и предубеждение", en: "Pride and Prejudice", year: 1813, coverIsbn: "9780141439518" },
      { ru: "Эмма", en: "Emma", year: 1815 },
      { ru: "Разум и чувства", en: "Sense and Sensibility", year: 1811 }
    ]
  },
  {
    displayName: "Шарлотта Бронте",
    aliases: ["бронте", "шарлотта бронте", "charlotte bronte", "bronte"],
    wikidataId: "Q127332",
    category: "Художественная литература",
    works: [
      { ru: "Джейн Эйр", en: "Jane Eyre", year: 1847 },
      { ru: "Виллетт", en: "Villette", year: 1853 }
    ]
  },
  {
    displayName: "Вольтер",
    aliases: ["вольтер", "voltaire"],
    wikidataId: "Q9062",
    category: "Философия",
    works: [
      { ru: "Кандид", en: "Candide", fr: "Candide", year: 1759 },
      { ru: "Философские письма", en: "Letters on the English", fr: "Lettres philosophiques", year: 1734 }
    ]
  },
  {
    displayName: "Данте Алигьери",
    aliases: ["данте", "dante", "dante alighieri"],
    wikidataId: "Q1067",
    category: "Классическая литература",
    works: [
      { ru: "Божественная комедия", en: "Divine Comedy", it: "Divina Commedia", year: 1320 }
    ]
  },
  {
    displayName: "Мигель де Сервантес",
    aliases: ["сервантес", "miguel de cervantes", "cervantes"],
    wikidataId: "Q5682",
    category: "Классическая литература",
    works: [
      { ru: "Дон Кихот", en: "Don Quixote", es: "Don Quijote de la Mancha", year: 1605 }
    ]
  },
  {
    displayName: "Джонатан Свифт",
    aliases: ["свифт", "джонатан свифт", "jonathan swift", "swift"],
    wikidataId: "Q41166",
    category: "Сатира",
    works: [
      { ru: "Путешествия Гулливера", en: "Gulliver's Travels", year: 1726 }
    ]
  },
  {
    displayName: "Джек Лондон",
    aliases: ["лондон", "джек лондон", "jack london", "london"],
    wikidataId: "Q4578",
    category: "Художественная литература",
    works: [
      { ru: "Зов предков", en: "The Call of the Wild", year: 1903 },
      { ru: "Белый Клык", en: "White Fang", year: 1906 },
      { ru: "Мартин Иден", en: "Martin Eden", year: 1909 }
    ]
  }
];

export const CURATED_CATALOG_SEED_VERSION = 6;

function normalize(value: string) {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function unique(values: string[], limit = 40) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = normalize(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

function authorScore(query: string, author: CuratedAuthor) {
  const normalizedQuery = normalize(query);
  const variants = unique([author.displayName, ...author.aliases], 20);
  let best = 0;
  for (const variant of variants) {
    const normalizedVariant = normalize(variant);
    if (!normalizedVariant) continue;
    if (normalizedQuery === normalizedVariant) best = Math.max(best, 100);
    else if (normalizedQuery.includes(normalizedVariant) || normalizedVariant.includes(normalizedQuery)) {
      best = Math.max(best, 88);
    } else {
      const queryTokens = normalizedQuery.split(" ").filter((token) => token.length > 1);
      const matched = queryTokens.filter((token) => normalizedVariant.includes(token)).length;
      if (queryTokens.length) best = Math.max(best, Math.round((matched / queryTokens.length) * 72));
    }
  }
  return best;
}

export function findCuratedAuthor(...queries: Array<string | undefined>) {
  const clean = unique(queries.filter(Boolean) as string[], 12);
  let best: { author: CuratedAuthor; score: number } | null = null;
  for (const author of CURATED_AUTHORS) {
    const score = Math.max(...clean.map((query) => authorScore(query, author)), 0);
    if (score >= 70 && (!best || score > best.score)) {
      best = { author, score };
    }
  }
  return best?.author || null;
}

export function getCuratedNotableWorks(...queries: Array<string | undefined>) {
  const author = findCuratedAuthor(...queries);
  if (!author) return [];
  return unique(
    author.works.flatMap((work) => [work.ru, work.en, work.de].filter(Boolean) as string[]),
    24
  );
}

export function getCuratedAuthorAliases(...queries: Array<string | undefined>) {
  const author = findCuratedAuthor(...queries);
  if (!author) return [];
  return unique([author.displayName, ...author.aliases], 16);
}

export function findCuratedWork(query: string, authorQuery?: string) {
  const normalizedQuery = normalize(query);
  const hintedAuthor = findCuratedAuthor(authorQuery, query);
  const authors = hintedAuthor
    ? [hintedAuthor]
    : findCuratedAuthor(query)
      ? [findCuratedAuthor(query)!]
      : CURATED_AUTHORS;
  let best: { author: CuratedAuthor; work: CuratedWork; score: number } | null = null;
  for (const author of authors) {
    for (const work of author.works) {
      const variants = unique([work.ru, work.en, work.de].filter(Boolean) as string[], 6);
      let score = 0;
      for (const variant of variants) {
        const normalizedVariant = normalize(variant);
        if (normalizedQuery === normalizedVariant) score = 100;
        else if (normalizedQuery.includes(normalizedVariant) || normalizedVariant.includes(normalizedQuery)) {
          score = Math.max(score, 82);
        }
      }
      if (score >= 70 && (!best || score > best.score)) best = { author, work, score };
    }
  }
  return best ? { author: best.author, work: best.work } : null;
}

function curatedReference(work: CuratedWork, author: CuratedAuthor): ProviderReference {
  const slug = createHash("sha1").update(`${author.displayName}|${work.ru}`).digest("hex").slice(0, 16);
  return {
    provider: "open-library",
    externalId: `curated:${slug}`,
    kind: "work"
  };
}

function openLibraryCoverByIsbn(isbn?: string) {
  return isbn ? `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-L.jpg?default=false` : undefined;
}

export function buildCuratedWorkCandidates(
  plan: ResolvedSearchPlan,
  settings: InternalSettings
): OnlineBookCandidate[] {
  const preferRussian = settings.preferRussian;

  if (plan.resolvedMode === "author") {
    const author = findCuratedAuthor(plan.originalQuery, plan.authorName, plan.canonicalQuery, ...plan.authorVariants);
    if (!author) return [];
    return author.works.map((work) => curatedWorkCandidate(work, author, preferRussian));
  }

  if (plan.resolvedMode === "title" || plan.source === "combined") {
    const match = findCuratedWork(
      plan.canonicalQuery || plan.originalQuery,
      plan.authorName || plan.originalQuery
    );
    if (!match) return [];
    const candidate = curatedWorkCandidate(match.work, match.author, preferRussian);
    candidate.score = preferRussian ? 1320 : 900;
    candidate.matchReasons = ["curated_catalog", "known_work_curated", "exact_title"];
    return [candidate];
  }

  return [];
}

function curatedWorkCandidate(work: CuratedWork, author: CuratedAuthor, preferRussian: boolean): OnlineBookCandidate {
  const reference = curatedReference(work, author);
  const alternateTitles = unique([work.ru, work.en, work.de].filter(Boolean) as string[], 6);
  const displayTitle = preferRussian ? work.ru : (work.en || work.ru);
  const coverUrl = openLibraryCoverByIsbn(work.coverIsbn);
  return {
    id: createHash("sha1").update(`curated|${reference.externalId}|${work.ru}`).digest("hex").slice(0, 20),
    providers: ["open-library"],
    references: [reference],
    title: displayTitle,
    originalTitle: work.en || work.de || work.ru,
    alternateTitles,
    author: preferRussian ? author.displayName : (author.aliases.find((item) => /[a-z]/i.test(item)) || author.displayName),
    firstPublishedYear: work.year ?? null,
    editionCount: 0,
    languages: preferRussian ? ["ru"] : unique([work.en ? "en" : "", work.ru ? "ru" : ""].filter(Boolean), 4),
    genres: [author.category],
    subjects: [author.category],
    coverUrl,
    coverRemoteUrl: coverUrl,
    coverKey: work.coverIsbn ? `isbn:${work.coverIsbn}` : undefined,
    sourceUrl: undefined,
    score: preferRussian ? 1180 : 760,
    completeness: 72,
    popularity: 120,
    matchConfidence: "high",
    matchReasons: ["curated_catalog", "known_work_curated"]
  };
}

export function isCuratedReference(reference: ProviderReference) {
  return reference.externalId.startsWith("curated:");
}

export function curatedAuthorResolution(query: string) {
  const author = findCuratedAuthor(query);
  if (!author) return null;
  return {
    name: author.displayName,
    aliases: unique([author.displayName, ...author.aliases], 16),
    confidence: 86,
    wikidataId: author.wikidataId,
    category: author.category
  };
}

export function listCuratedCatalogRows() {
  return CURATED_AUTHORS.flatMap((author) =>
    author.works.map((work) => ({
      titleRu: work.ru,
      titleEn: work.en,
      author: author.displayName,
      authorAliases: author.aliases.join(" "),
      wikidataId: author.wikidataId
    }))
  );
}
