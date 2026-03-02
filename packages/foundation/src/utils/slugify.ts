/**
 * Regex pattern for URL-friendly identifiers.
 * Allows alphanumeric characters, hyphens, and underscores.
 */
export const URL_FRIENDLY_REGEX = /^[a-zA-Z0-9-_]+$/;

/**
 * Checks if a string is URL-friendly (contains only alphanumeric characters, hyphens, and underscores).
 */
export function isUrlFriendly(str: string): boolean {
  return URL_FRIENDLY_REGEX.test(str);
}

// same with underscore
export function slugify(str: string) {
    let slug = str.replace(/^\s+|\s+$/g, ''); // trim leading/trailing white space
    slug = slug.toLowerCase(); // convert string to lowercase
    // german umlauts
    slug = slug.replace(/ä/g, 'ae');
    slug = slug.replace(/ö/g, 'oe');
    slug = slug.replace(/ü/g, 'ue');
    slug = slug.replace(/ß/g, 'ss');
    // Letter "e"
    slug = slug.replace(/e|é|è|ẽ|ẻ|ẹ|ê|ế|ề|ễ|ể|ệ/gi, 'e');
    // Letter "a"
    slug = slug.replace(/a|á|à|ã|ả|ạ|ă|ắ|ằ|ẵ|ẳ|ặ|â|ấ|ầ|ẫ|ẩ|ậ/gi, 'a');
    // Letter "o"
    slug = slug.replace(/o|ó|ò|õ|ỏ|ọ|ô|ố|ồ|ỗ|ổ|ộ|ơ|ớ|ờ|ỡ|ở|ợ/gi, 'o');
    // Letter "u"
    slug = slug.replace(/u|ú|ù|ũ|ủ|û|ụ|ư|ứ|ừ|ữ|ử|ự/gi, 'u');
    // Letter "s"
    slug = slug.replace(/s|ş|ș/gi, 's');
    // Letter "t"
    slug = slug.replace(/t|ţ|ț/gi, 't');
    // Letter "i"
    slug = slug.replace(/i|í|î/gi, 'i');
    // Letter "d"
    slug = slug.replace(/đ/gi, 'd');
    // Trim the last whitespace
    slug = slug.replace(/\s*$/g, '');
    // Change whitespace to "-"
    slug = slug.replace(/\s+/g, '-');
    // Remove all non-word characters
    return slug.replace(/[^a-zA-Z0-9-_]+/g, '');
}
